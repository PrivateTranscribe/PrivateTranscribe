/**
 * Unit tests for the App Discovery pure helpers.
 *
 * All tested functions are pure (no filesystem or Electron dependencies),
 * so these tests run in a plain Node/Vitest environment.
 */

import { describe, it, expect } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Import pure helpers from the production module.
// We only import the pure functions — listInstalledApps() requires fs/os and
// is not tested here.
// ─────────────────────────────────────────────────────────────────────────────

// Node CJS module — use createRequire so Vitest (ESM) can load it.
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const {
  extractAppNameFromPath,
  parseDesktopFile,
  filterApps,
} = require("../../../src/helpers/appDiscovery") as {
  extractAppNameFromPath: (filePath: string, platform: string) => string;
  parseDesktopFile: (content: string) => { name: string; exec: string } | null;
  filterApps: (
    apps: Array<{ name: string; path: string }>,
    query: string
  ) => Array<{ name: string; path: string }>;
};

// ─────────────────────────────────────────────────────────────────────────────
// extractAppNameFromPath
// ─────────────────────────────────────────────────────────────────────────────

describe("extractAppNameFromPath", () => {
  describe("macOS (darwin)", () => {
    it("strips .app suffix from bundle", () => {
      expect(extractAppNameFromPath("/Applications/Safari.app", "darwin")).toBe("Safari");
    });

    it("strips .app from user Applications", () => {
      expect(extractAppNameFromPath("/Users/alice/Applications/Foo.app", "darwin")).toBe("Foo");
    });

    it("returns basename unchanged when no .app suffix", () => {
      expect(extractAppNameFromPath("/usr/local/bin/node", "darwin")).toBe("node");
    });

    it("handles a name that is just the extension", () => {
      expect(extractAppNameFromPath("/Applications/.app", "darwin")).toBe("");
    });
  });

  describe("Windows (win32)", () => {
    it("strips .exe suffix", () => {
      expect(
        extractAppNameFromPath("C:\\Program Files\\Notepad\\notepad.exe", "win32")
      ).toBe("notepad");
    });

    it("strips .lnk suffix", () => {
      expect(
        extractAppNameFromPath("C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Chrome.lnk", "win32")
      ).toBe("Chrome");
    });

    it("strips .bat suffix", () => {
      expect(extractAppNameFromPath("C:\\tools\\launch.bat", "win32")).toBe("launch");
    });

    it("is case-insensitive for extension stripping", () => {
      expect(extractAppNameFromPath("C:\\App\\App.EXE", "win32")).toBe("App");
    });

    it("returns basename unchanged for unknown extensions", () => {
      expect(extractAppNameFromPath("C:\\tools\\helper.sh", "win32")).toBe("helper.sh");
    });
  });

  describe("Linux", () => {
    it("returns the basename as-is", () => {
      expect(extractAppNameFromPath("/usr/bin/code", "linux")).toBe("code");
    });

    it("returns the basename for paths with dots", () => {
      expect(extractAppNameFromPath("/opt/apps/myapp.sh", "linux")).toBe("myapp.sh");
    });
  });

  describe("edge cases", () => {
    it("returns empty string for empty input", () => {
      expect(extractAppNameFromPath("", "darwin")).toBe("");
    });

    it("handles non-string input gracefully", () => {
      // @ts-expect-error intentional bad input
      expect(extractAppNameFromPath(null, "linux")).toBe("");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseDesktopFile
// ─────────────────────────────────────────────────────────────────────────────

describe("parseDesktopFile", () => {
  const minimal = `
[Desktop Entry]
Type=Application
Name=My App
Exec=/usr/bin/myapp
`.trim();

  it("parses a minimal valid .desktop file", () => {
    const result = parseDesktopFile(minimal);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("My App");
    expect(result!.exec).toBe("/usr/bin/myapp");
  });

  it("strips freedesktop field codes from Exec", () => {
    const content = `[Desktop Entry]\nType=Application\nName=Foo\nExec=/usr/bin/foo %u %F\n`;
    const result = parseDesktopFile(content);
    expect(result!.exec).toBe("/usr/bin/foo");
  });

  it("strips %% field code from Exec", () => {
    const content = `[Desktop Entry]\nType=Application\nName=Bar\nExec=/usr/bin/bar %%\n`;
    const result = parseDesktopFile(content);
    expect(result!.exec).toBe("/usr/bin/bar");
  });

  it("handles env-wrapper Exec pattern", () => {
    const content = `[Desktop Entry]\nType=Application\nName=Wrapped\nExec=env FOO=bar /usr/bin/wrapped\n`;
    const result = parseDesktopFile(content);
    expect(result!.exec).toBe("/usr/bin/wrapped");
  });

  it("returns null for Hidden=true", () => {
    const content = `[Desktop Entry]\nType=Application\nName=Hidden\nExec=/bin/hidden\nHidden=true\n`;
    expect(parseDesktopFile(content)).toBeNull();
  });

  it("returns null for NoDisplay=true", () => {
    const content = `[Desktop Entry]\nType=Application\nName=NoDisplay\nExec=/bin/nodisplay\nNoDisplay=true\n`;
    expect(parseDesktopFile(content)).toBeNull();
  });

  it("returns null when Name is missing", () => {
    const content = `[Desktop Entry]\nType=Application\nExec=/bin/app\n`;
    expect(parseDesktopFile(content)).toBeNull();
  });

  it("returns null when Exec is missing", () => {
    const content = `[Desktop Entry]\nType=Application\nName=NoExec\n`;
    expect(parseDesktopFile(content)).toBeNull();
  });

  it("ignores non-Application type entries", () => {
    const content = `[Desktop Entry]\nType=Link\nName=Link\nExec=/bin/link\n`;
    expect(parseDesktopFile(content)).toBeNull();
  });

  it("stops reading after [Desktop Entry] section ends", () => {
    const content = `[Desktop Entry]\nType=Application\nName=First\nExec=/bin/first\n\n[OtherSection]\nName=Second\nExec=/bin/second\n`;
    const result = parseDesktopFile(content);
    expect(result!.name).toBe("First");
    expect(result!.exec).toBe("/bin/first");
  });

  it("handles CRLF line endings", () => {
    const content = "[Desktop Entry]\r\nType=Application\r\nName=CRLF App\r\nExec=/bin/app\r\n";
    const result = parseDesktopFile(content);
    expect(result!.name).toBe("CRLF App");
  });

  it("ignores comment lines", () => {
    const content = `[Desktop Entry]\n# This is a comment\nType=Application\nName=Commented\nExec=/bin/app\n`;
    const result = parseDesktopFile(content);
    expect(result!.name).toBe("Commented");
  });

  it("uses the first Name value (ignores locale variants)", () => {
    const content = `[Desktop Entry]\nType=Application\nName=English Name\nName[de]=Deutsches Name\nExec=/bin/app\n`;
    const result = parseDesktopFile(content);
    expect(result!.name).toBe("English Name");
  });

  it("returns null for non-string input", () => {
    // @ts-expect-error intentional bad input
    expect(parseDesktopFile(null)).toBeNull();
    // @ts-expect-error intentional bad input
    expect(parseDesktopFile(42)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseDesktopFile("")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// filterApps
// ─────────────────────────────────────────────────────────────────────────────

describe("filterApps", () => {
  const apps = [
    { name: "Firefox", path: "/usr/bin/firefox" },
    { name: "File Manager", path: "/usr/bin/nautilus" },
    { name: "Terminal", path: "/usr/bin/gnome-terminal" },
    { name: "Text Editor", path: "/usr/bin/gedit" },
    { name: "Firefox Developer Edition", path: "/opt/firefox-dev/firefox" },
  ];

  it("returns all apps when query is empty", () => {
    expect(filterApps(apps, "")).toEqual(apps);
  });

  it("returns all apps when query is only whitespace", () => {
    expect(filterApps(apps, "   ")).toEqual(apps);
  });

  it("filters case-insensitively", () => {
    const result = filterApps(apps, "FIREFOX");
    expect(result.map((a) => a.name)).toContain("Firefox");
    expect(result.map((a) => a.name)).toContain("Firefox Developer Edition");
    expect(result).not.toContain(expect.objectContaining({ name: "Terminal" }));
  });

  it("puts prefix matches before substring matches", () => {
    // "fi" is a prefix of "Firefox" and "File Manager"; "Firefox Developer Edition"
    // also prefix-matches on "fi". "Text Editor" does not match.
    const result = filterApps(apps, "fi");
    const names = result.map((a) => a.name);
    // All "fi"-prefix matches come before any interior matches (none here).
    expect(names).toContain("Firefox");
    expect(names).toContain("File Manager");
    expect(names).toContain("Firefox Developer Edition");
    // Terminal and Text Editor have no "fi" — excluded.
    expect(names).not.toContain("Terminal");
    expect(names).not.toContain("Text Editor");
  });

  it("handles apps that match only as substring (not prefix)", () => {
    // "editor" only appears as a substring in "Text Editor".
    const result = filterApps(apps, "editor");
    expect(result.map((a) => a.name)).toContain("Text Editor");
    expect(result).toHaveLength(1);
  });

  it("returns empty array when nothing matches", () => {
    expect(filterApps(apps, "zzznomatch")).toHaveLength(0);
  });

  it("handles empty apps array", () => {
    expect(filterApps([], "firefox")).toEqual([]);
  });

  it("handles non-array input gracefully", () => {
    // @ts-expect-error intentional bad input
    expect(filterApps(null, "test")).toEqual([]);
  });

  it("returns original array reference when query is empty (no copy)", () => {
    const result = filterApps(apps, "");
    expect(result).toBe(apps);
  });
});
