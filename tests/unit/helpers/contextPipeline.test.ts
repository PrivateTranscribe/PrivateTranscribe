/**
 * Unit tests for contextPipeline — the shared Smart Context helper.
 *
 * Pure functions (buildWhisperContextHint, parseFilenameFromTitle) are tested
 * without any mocking.  getContext / isSmartContextEnabled / extractFileIdentifiers
 * tests manipulate globalThis.window and module mocks to stay isolated from
 * Electron and the Pro-entitlement check.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Mock useProStatus so getEffectiveEntitlement is controllable in every test.
// ─────────────────────────────────────────────────────────────────────────────
vi.mock("../../../src/hooks/useProStatus", () => ({
  getEffectiveEntitlement: vi.fn(() => "pro"),
}));

import { getEffectiveEntitlement } from "../../../src/hooks/useProStatus";

// Import after mocks are set up
import {
  buildWhisperContextHint,
  buildFileIdentifierHint,
  getContext,
  isSmartContextEnabled,
  isFileIdentifiersEnabled,
  isLlmContextEnhancementEnabled,
  extractFileIdentifiers,
  parseFilenameFromTitle,
} from "../../../src/helpers/contextPipeline";

// ─────────────────────────────────────────────────────────────────────────────
// Import pure helpers from fileIdentifierExtractor for sensitivity tests
// ─────────────────────────────────────────────────────────────────────────────
import { isSafeFilePath, isFileTooLarge, extractIdentifiers } from "../../../src/helpers/fileIdentifierExtractor";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeWindow(overrides: Record<string, unknown> = {}): typeof window {
  return {
    electronAPI: {
      getActiveWindowContext: vi.fn(),
      extractFileIdentifiers: vi.fn(),
    },
    localStorage: {
      getItem: vi.fn(() => null),
    },
    ...overrides,
  } as unknown as typeof window;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildWhisperContextHint — pure function, no mocking needed
// ─────────────────────────────────────────────────────────────────────────────

describe("buildWhisperContextHint", () => {
  it("returns null for null input", () => {
    expect(buildWhisperContextHint(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(buildWhisperContextHint(undefined)).toBeNull();
  });

  it("returns null when available is false", () => {
    expect(buildWhisperContextHint({ available: false, source: "timeout" })).toBeNull();
  });

  it("returns null when available is true but no useful fields", () => {
    expect(buildWhisperContextHint({ available: true, source: "ipc" })).toBeNull();
  });

  it("includes appName only", () => {
    const hint = buildWhisperContextHint({ available: true, source: "ipc", appName: "Chrome" });
    expect(hint).toBe("App: Chrome");
  });

  it("includes windowTitle only", () => {
    const hint = buildWhisperContextHint({
      available: true,
      source: "ipc",
      windowTitle: "GitHub – Pull Requests",
    });
    expect(hint).toBe("Window: GitHub – Pull Requests");
  });

  it("includes both appName and windowTitle", () => {
    const hint = buildWhisperContextHint({
      available: true,
      source: "ipc",
      appName: "VS Code",
      windowTitle: "main.ts — my-project",
    });
    expect(hint).toBe("App: VS Code, Window: main.ts — my-project");
  });

  it("falls back to processName when appName is absent", () => {
    const hint = buildWhisperContextHint({
      available: true,
      source: "ipc",
      processName: "code.exe",
    });
    expect(hint).toBe("App: code.exe");
  });

  it("falls back to appClass when appName and processName are absent", () => {
    const hint = buildWhisperContextHint({ available: true, source: "ipc", appClass: "firefox" });
    expect(hint).toBe("App: firefox");
  });

  it("truncates long window titles to 80 chars with ellipsis", () => {
    const longTitle = "A".repeat(100);
    const hint = buildWhisperContextHint({ available: true, source: "ipc", windowTitle: longTitle });
    expect(hint).not.toBeNull();
    expect(hint!.length).toBeLessThanOrEqual("Window: ".length + 80);
    expect(hint).toContain("...");
  });

  it("does NOT include uiaText (too verbose for Whisper)", () => {
    const hint = buildWhisperContextHint({
      available: true,
      source: "ipc",
      appName: "Notepad",
      uiaText: "This is sensitive focused element text",
    });
    expect(hint).not.toContain("uia");
    expect(hint).not.toContain("focused element text");
    expect(hint).not.toContain("sensitive");
    expect(hint).toBe("App: Notepad");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildFileIdentifierHint — pure function
// ─────────────────────────────────────────────────────────────────────────────

describe("buildFileIdentifierHint", () => {
  it("returns null for null input", () => {
    expect(buildFileIdentifierHint(null)).toBeNull();
  });

  it("returns null when available is false", () => {
    expect(buildFileIdentifierHint({ available: false, reason: "not found" })).toBeNull();
  });

  it("returns null when identifiers array is empty", () => {
    expect(buildFileIdentifierHint({ available: true, identifiers: [] })).toBeNull();
  });

  it("returns hint with identifiers joined", () => {
    const hint = buildFileIdentifierHint({
      available: true,
      identifiers: ["getContext", "isSmartContextEnabled", "buildHint"],
    });
    expect(hint).toBe("Identifiers: getContext isSmartContextEnabled buildHint");
  });

  it("caps at 15 identifiers", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `identifier${i}`);
    const hint = buildFileIdentifierHint({ available: true, identifiers: ids });
    expect(hint).not.toBeNull();
    // 15 identifiers joined with spaces = 14 spaces + 15 * len("identifierXX")
    const idCount = hint!.replace("Identifiers: ", "").split(" ").length;
    expect(idCount).toBe(15);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseFilenameFromTitle — pure function
// ─────────────────────────────────────────────────────────────────────────────

describe("parseFilenameFromTitle", () => {
  it("returns null for null input", () => {
    expect(parseFilenameFromTitle(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseFilenameFromTitle("")).toBeNull();
  });

  it("extracts filename from VS Code em-dash format", () => {
    expect(parseFilenameFromTitle("App.jsx — privoca — Visual Studio Code")).toBe("App.jsx");
  });

  it("extracts filename from Sublime Text hyphen format", () => {
    expect(parseFilenameFromTitle("main.ts - Sublime Text")).toBe("main.ts");
  });

  it("extracts filename from JetBrains bracket format", () => {
    expect(parseFilenameFromTitle("index.py [myproject] - PyCharm")).toBe("index.py");
  });

  it("returns null when no recognizable pattern", () => {
    expect(parseFilenameFromTitle("Google Chrome")).toBeNull();
    expect(parseFilenameFromTitle("Slack — privoca")).toBeNull();
  });

  it("handles filenames with dots", () => {
    expect(parseFilenameFromTitle("my.config.ts — project — VS Code")).toBe("my.config.ts");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getContext
// ─────────────────────────────────────────────────────────────────────────────

describe("getContext", () => {
  let originalWindow: typeof globalThis.window;

  beforeEach(() => {
    originalWindow = globalThis.window;
  });

  afterEach(() => {
    globalThis.window = originalWindow;
  });

  it("returns unavailable when electronAPI is absent", async () => {
    globalThis.window = makeWindow({ electronAPI: undefined });
    const result = await getContext();
    expect(result.available).toBe(false);
    expect(result.source).toBe("unavailable");
  });

  it("returns unavailable when getActiveWindowContext is not a function", async () => {
    globalThis.window = makeWindow({
      electronAPI: { getActiveWindowContext: "not-a-function" },
    });
    const result = await getContext();
    expect(result.available).toBe(false);
    expect(result.source).toBe("unavailable");
  });

  it("returns unavailable with reason when IPC resolves to null", async () => {
    globalThis.window = makeWindow({
      electronAPI: {
        getActiveWindowContext: vi.fn().mockResolvedValue(null),
        extractFileIdentifiers: vi.fn(),
      },
    });
    const result = await getContext();
    expect(result.available).toBe(false);
    expect(result.source).toBe("unavailable");
  });

  it("returns ipc result with source:'ipc' on success", async () => {
    const ipcResult = {
      available: true,
      platform: "linux" as const,
      appClass: "firefox",
      windowTitle: "GitHub",
    };
    globalThis.window = makeWindow({
      electronAPI: {
        getActiveWindowContext: vi.fn().mockResolvedValue(ipcResult),
        extractFileIdentifiers: vi.fn(),
      },
    });

    const result = await getContext();
    expect(result.available).toBe(true);
    expect(result.source).toBe("ipc");
    expect(result.appClass).toBe("firefox");
    expect(result.windowTitle).toBe("GitHub");
  });

  it("returns timeout result when IPC takes longer than timeoutMs", async () => {
    vi.useFakeTimers();

    const neverResolves = new Promise(() => {/* intentionally never settles */});
    globalThis.window = makeWindow({
      electronAPI: {
        getActiveWindowContext: vi.fn().mockReturnValue(neverResolves),
        extractFileIdentifiers: vi.fn(),
      },
    });

    const resultPromise = getContext({ timeoutMs: 100 });
    vi.advanceTimersByTime(200);
    const result = await resultPromise;

    expect(result.available).toBe(false);
    expect(result.source).toBe("timeout");

    vi.useRealTimers();
  });

  it("returns error result when IPC throws", async () => {
    globalThis.window = makeWindow({
      electronAPI: {
        getActiveWindowContext: vi.fn().mockRejectedValue(new Error("IPC channel closed")),
        extractFileIdentifiers: vi.fn(),
      },
    });

    const result = await getContext();
    expect(result.available).toBe(false);
    expect(result.source).toBe("error");
    expect(result.reason).toContain("IPC channel closed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isSmartContextEnabled
// ─────────────────────────────────────────────────────────────────────────────

describe("isSmartContextEnabled", () => {
  let originalWindow: typeof globalThis.window;
  const mockGetEntitlement = getEffectiveEntitlement as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalWindow = globalThis.window;
    mockGetEntitlement.mockReturnValue("pro");
  });

  afterEach(() => {
    globalThis.window = originalWindow;
  });

  it("returns false when window is undefined", () => {
    // @ts-expect-error intentional
    globalThis.window = undefined;
    expect(isSmartContextEnabled()).toBe(false);
  });

  it("returns false when entitlement is not pro", () => {
    mockGetEntitlement.mockReturnValue("free");
    globalThis.window = makeWindow({
      localStorage: { getItem: vi.fn().mockReturnValue("true") },
    });
    expect(isSmartContextEnabled()).toBe(false);
  });

  it("returns true when smartContextEnabled is 'true' (new key)", () => {
    globalThis.window = makeWindow({
      localStorage: {
        getItem: vi.fn((key: string) => (key === "smartContextEnabled" ? "true" : null)),
      },
    });
    expect(isSmartContextEnabled()).toBe(true);
  });

  it("returns false when smartContextEnabled is 'false'", () => {
    globalThis.window = makeWindow({
      localStorage: {
        getItem: vi.fn((key: string) => (key === "smartContextEnabled" ? "false" : null)),
      },
    });
    expect(isSmartContextEnabled()).toBe(false);
  });

  it("returns true when entitlement is pro and enableContextCapture is 'true' (legacy key)", () => {
    globalThis.window = makeWindow({
      localStorage: {
        getItem: vi.fn((key: string) => {
          if (key === "enableContextCapture") return "true";
          return null;
        }),
      },
    });
    expect(isSmartContextEnabled()).toBe(true);
  });

  it("returns false when enableContextCapture is 'false' even with pro entitlement", () => {
    globalThis.window = makeWindow({
      localStorage: {
        getItem: vi.fn((key: string) => (key === "enableContextCapture" ? "false" : null)),
      },
    });
    expect(isSmartContextEnabled()).toBe(false);
  });

  it("falls back to legacy includeActiveWindowContextInReasoning key", () => {
    globalThis.window = makeWindow({
      localStorage: {
        getItem: vi.fn((key: string) => {
          if (key === "includeActiveWindowContextInReasoning") return "true";
          return null;
        }),
      },
    });
    expect(isSmartContextEnabled()).toBe(true);
  });

  it("returns false when neither key is set", () => {
    globalThis.window = makeWindow({
      localStorage: { getItem: vi.fn().mockReturnValue(null) },
    });
    expect(isSmartContextEnabled()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isFileIdentifiersEnabled / isLlmContextEnhancementEnabled
// ─────────────────────────────────────────────────────────────────────────────

describe("isFileIdentifiersEnabled", () => {
  let originalWindow: typeof globalThis.window;
  const mockGetEntitlement = getEffectiveEntitlement as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalWindow = globalThis.window;
    mockGetEntitlement.mockReturnValue("pro");
  });

  afterEach(() => {
    globalThis.window = originalWindow;
  });

  it("returns false when smart context is disabled", () => {
    globalThis.window = makeWindow({
      localStorage: {
        getItem: vi.fn().mockReturnValue(null), // smartContextEnabled not set → false
      },
    });
    expect(isFileIdentifiersEnabled()).toBe(false);
  });

  it("returns true when both smartContextEnabled and enableFileIdentifiers are true", () => {
    globalThis.window = makeWindow({
      localStorage: {
        getItem: vi.fn((key: string) => {
          if (key === "smartContextEnabled") return "true";
          if (key === "enableFileIdentifiers") return "true";
          return null;
        }),
      },
    });
    expect(isFileIdentifiersEnabled()).toBe(true);
  });

  it("returns false when smartContextEnabled is true but enableFileIdentifiers is not set", () => {
    globalThis.window = makeWindow({
      localStorage: {
        getItem: vi.fn((key: string) => (key === "smartContextEnabled" ? "true" : null)),
      },
    });
    expect(isFileIdentifiersEnabled()).toBe(false);
  });
});

describe("isLlmContextEnhancementEnabled", () => {
  let originalWindow: typeof globalThis.window;
  const mockGetEntitlement = getEffectiveEntitlement as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalWindow = globalThis.window;
    mockGetEntitlement.mockReturnValue("pro");
  });

  afterEach(() => {
    globalThis.window = originalWindow;
  });

  it("returns false when not set", () => {
    globalThis.window = makeWindow({
      localStorage: { getItem: vi.fn().mockReturnValue(null) },
    });
    expect(isLlmContextEnhancementEnabled()).toBe(false);
  });

  it("returns true when llmContextEnhancement is 'true'", () => {
    globalThis.window = makeWindow({
      localStorage: {
        getItem: vi.fn((key: string) => (key === "llmContextEnhancement" ? "true" : null)),
      },
    });
    expect(isLlmContextEnhancementEnabled()).toBe(true);
  });

  it("returns false when entitlement is free even if flag is set", () => {
    mockGetEntitlement.mockReturnValue("free");
    globalThis.window = makeWindow({
      localStorage: {
        getItem: vi.fn((key: string) => (key === "llmContextEnhancement" ? "true" : null)),
      },
    });
    expect(isLlmContextEnhancementEnabled()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractFileIdentifiers
// ─────────────────────────────────────────────────────────────────────────────

describe("extractFileIdentifiers", () => {
  let originalWindow: typeof globalThis.window;

  beforeEach(() => {
    originalWindow = globalThis.window;
  });

  afterEach(() => {
    globalThis.window = originalWindow;
  });

  it("returns unavailable when no filename found in title", async () => {
    const result = await extractFileIdentifiers("Google Chrome");
    expect(result.available).toBe(false);
    expect(result.reason).toContain("no filename");
  });

  it("identifier extraction: extracts App.jsx from VS Code title and returns identifiers", async () => {
    globalThis.window = makeWindow({
      electronAPI: {
        extractFileIdentifiers: vi.fn().mockResolvedValue({
          blocked: false,
          identifiers: ["getContext", "isSmartContextEnabled", "buildWhisperContextHint"],
          filename: "App.jsx",
        }),
        getActiveWindowContext: vi.fn(),
      },
      localStorage: { getItem: vi.fn(() => null) },
    });

    const result = await extractFileIdentifiers("App.jsx — VS Code — privoca");
    expect(result.available).toBe(true);
    expect(result.identifiers).toContain("getContext");
    expect(result.filename).toBe("App.jsx");
    // Verify the IPC was called with just the filename, not the full title
    const mockFn = (globalThis.window as any).electronAPI.extractFileIdentifiers;
    expect(mockFn).toHaveBeenCalledWith("App.jsx");
  });

  it("returns unavailable when IPC not available", async () => {
    globalThis.window = makeWindow({ electronAPI: undefined });
    const result = await extractFileIdentifiers("App.jsx — VS Code");
    expect(result.available).toBe(false);
    expect(result.reason).toContain("IPC not available");
  });

  it("returns unavailable when IPC reports file blocked", async () => {
    globalThis.window = makeWindow({
      electronAPI: {
        extractFileIdentifiers: vi.fn().mockResolvedValue({
          blocked: true,
          reason: "outside home dir",
          identifiers: [],
        }),
        getActiveWindowContext: vi.fn(),
      },
      localStorage: { getItem: vi.fn(() => null) },
    });

    const result = await extractFileIdentifiers("App.jsx — VS Code");
    expect(result.available).toBe(false);
    expect(result.reason).toBe("outside home dir");
  });

  it("returns timeout result when IPC takes too long", async () => {
    vi.useFakeTimers();

    const neverResolves = new Promise(() => {});
    globalThis.window = makeWindow({
      electronAPI: {
        extractFileIdentifiers: vi.fn().mockReturnValue(neverResolves),
        getActiveWindowContext: vi.fn(),
      },
      localStorage: { getItem: vi.fn(() => null) },
    });

    const resultPromise = extractFileIdentifiers("App.jsx — VS Code", { timeoutMs: 50 });
    vi.advanceTimersByTime(100);
    const result = await resultPromise;

    expect(result.available).toBe(false);
    expect(result.reason).toContain("timed out");

    vi.useRealTimers();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fileIdentifierExtractor — pure helper functions (sensitivity tests)
// ─────────────────────────────────────────────────────────────────────────────

describe("isSafeFilePath", () => {
  const homeDir = "/home/alice";

  it("returns true for a file directly in home dir", () => {
    expect(isSafeFilePath("/home/alice/myfile.txt", homeDir)).toBe(true);
  });

  it("returns true for a file in a subdirectory of home", () => {
    expect(isSafeFilePath("/home/alice/projects/app/src/App.jsx", homeDir)).toBe(true);
  });

  it("sensitivity: returns false for a file outside home dir", () => {
    expect(isSafeFilePath("/etc/passwd", homeDir)).toBe(false);
  });

  it("sensitivity: returns false for /tmp files", () => {
    expect(isSafeFilePath("/tmp/secretfile.txt", homeDir)).toBe(false);
  });

  it("sensitivity: returns false for path traversal attack", () => {
    expect(isSafeFilePath("/home/alice/../bob/evil.txt", homeDir)).toBe(false);
  });

  it("sensitivity: returns false for a different user home dir", () => {
    expect(isSafeFilePath("/home/bob/file.txt", homeDir)).toBe(false);
  });
});

describe("isFileTooLarge", () => {
  it("returns false for a small file", () => {
    expect(isFileTooLarge(1024)).toBe(false); // 1 KB
  });

  it("returns false for a file exactly at the limit", () => {
    expect(isFileTooLarge(500 * 1024)).toBe(false); // exactly 500 KB
  });

  it("sensitivity: returns true for a file just over the limit", () => {
    expect(isFileTooLarge(500 * 1024 + 1)).toBe(true);
  });

  it("sensitivity: returns true for a 1 MB file", () => {
    expect(isFileTooLarge(1024 * 1024)).toBe(true);
  });

  it("respects custom maxBytes", () => {
    expect(isFileTooLarge(200, 100)).toBe(true);
    expect(isFileTooLarge(50, 100)).toBe(false);
  });
});

describe("extractIdentifiers", () => {
  it("extracts camelCase identifiers", () => {
    const ids = extractIdentifiers("const getContext = () => {}; let isEnabled = true;");
    expect(ids).toContain("getContext");
    expect(ids).toContain("isEnabled");
  });

  it("extracts snake_case identifiers", () => {
    const ids = extractIdentifiers("const my_variable = 1; function http_client() {}");
    expect(ids).toContain("my_variable");
    expect(ids).toContain("http_client");
  });

  it("extracts named function declarations", () => {
    const ids = extractIdentifiers("function buildWhisperContextHint(ctx) { return null; }");
    expect(ids).toContain("buildWhisperContextHint");
  });

  it("extracts arrow function variable names", () => {
    const ids = extractIdentifiers("const extractFileIds = async (title) => {};");
    expect(ids).toContain("extractFileIds");
  });

  it("does not return identifiers shorter than 3 chars", () => {
    const ids = extractIdentifiers("const ab = 1; let xy = 2;");
    expect(ids).not.toContain("ab");
    expect(ids).not.toContain("xy");
  });

  it("caps results at 50 identifiers", () => {
    // Generate content with > 50 distinct camelCase identifiers
    const content = Array.from({ length: 60 }, (_, i) => `const myVar${i}A = ${i};`).join("\n");
    const ids = extractIdentifiers(content);
    expect(ids.length).toBeLessThanOrEqual(50);
  });
});
