import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import { afterAll, describe, expect, it } from "vitest";

const {
  RUN_KEY,
  APPROVED_KEY,
  parseRegExport,
  defaultRegReader,
  extractExecutable,
  isApprovedBinary,
  readAutoStartRegistryState,
  findOtherRunValueOwner,
  registryAutoStartEnabled,
} = require("../../../src/helpers/windowsAutoStartRegistry");

const EXE = "C:\\Program Files\\PrivateTranscribe\\PrivateTranscribe.exe";
const SOREN_EXE =
  "C:\\Users\\Søren\\AppData\\Local\\Programs\\PrivateTranscribe\\PrivateTranscribe.exe";

/** A value as `reg export` writes it: backslashes and quotes escaped. */
const regString = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** `reg export` text for one key, BOM included, as it reads back from the UTF-16 file. */
const exportOf = (key: string, lines: string[]) =>
  [
    "\uFEFFWindows Registry Editor Version 5.00",
    "",
    `[HKEY_CURRENT_USER\\${key.replace(/^HKCU\\/, "")}]`,
    ...lines,
    "",
    "",
  ].join("\r\n");

const runEntry = (name: string, data: string) => `${regString(name)}=${regString(data)}`;

describe("parseRegExport", () => {
  it("reads the Run key reg export wrote for Søren, Ωmega and 李雷", () => {
    // Captured from reg.exe on Windows 11 (da-DK, code pages 1252 and 850), 2026-10-19.
    const text = [
      "\uFEFFWindows Registry Editor Version 5.00",
      "",
      String.raw`[HKEY_CURRENT_USER\Software\PrivateTranscribe-unicode-probe\Run]`,
      String.raw`"PrivateTranscribe"="\"C:\\Users\\Søren Ωmega 李雷\\AppData\\Local\\Programs\\PrivateTranscribe\\PrivateTranscribe.exe\" --process-start-args \"--hidden\""`,
      '"Zoë"=hex(2):25,00,4c,00,4f,00,43,00,41,00,4c,00,41,00,50,00,50,00,44,00,41,00,\\',
      "  54,00,41,00,25,00,5c,00,5a,00,6f,00,eb,00,5c,00,61,00,70,00,70,00,2e,00,65,\\",
      "  00,78,00,65,00,00,00",
      String.raw`"Quote \"Name\""="C:\\a b\\c.exe"`,
      "",
      String.raw`[HKEY_CURRENT_USER\Software\PrivateTranscribe-unicode-probe\Run\SubKey]`,
      String.raw`"Nested"="nested"`,
      "",
      "",
    ].join("\r\n");

    expect(parseRegExport(text)).toEqual([
      {
        name: "PrivateTranscribe",
        type: "REG_SZ",
        data: '"C:\\Users\\Søren Ωmega 李雷\\AppData\\Local\\Programs\\PrivateTranscribe\\PrivateTranscribe.exe" --process-start-args "--hidden"',
      },
      { name: "Zoë", type: "REG_EXPAND_SZ", data: "%LOCALAPPDATA%\\Zoë\\app.exe" },
      { name: 'Quote "Name"', type: "REG_SZ", data: "C:\\a b\\c.exe" },
    ]);
  });

  it("returns StartupApproved flags as the hex string isApprovedBinary reads", () => {
    const rows = parseRegExport(
      exportOf(APPROVED_KEY, [`"PrivateTranscribe"=hex:03,00,00,00,00,00,00,00,00,00,00,00`])
    );

    expect(rows).toEqual([
      { name: "PrivateTranscribe", type: "REG_BINARY", data: "030000000000000000000000" },
    ]);
    expect(isApprovedBinary(rows[0].data)).toBe(false);
  });

  it("reads the default value and skips types it does not need", () => {
    expect(
      parseRegExport(exportOf(RUN_KEY, ['@="C:\\\\x.exe"', '"Count"=dword:00000001']))
    ).toEqual([{ name: "", type: "REG_SZ", data: "C:\\x.exe" }]);
  });

  it("returns no rows for empty or unrelated text", () => {
    expect(parseRegExport("")).toEqual([]);
    expect(parseRegExport(undefined)).toEqual([]);
    expect(
      parseRegExport("ERROR: The system was unable to find the specified registry key")
    ).toEqual([]);
  });
});

describe("extractExecutable", () => {
  it("reads a quoted path, which is how Electron writes ours", () => {
    expect(extractExecutable(`"${EXE}" --launch-at-login --startup-mode=tray`)).toBe(EXE);
  });

  it("reads an unquoted path that contains spaces", () => {
    // Electron's own launchItems mangles this case into path "C:\\Program" plus args.
    expect(extractExecutable("C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe")).toBe(
      "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"
    );
  });

  it("stops at the executable when unquoted args follow", () => {
    expect(extractExecutable("C:\\Program Files\\App\\app.exe --silent -x")).toBe(
      "C:\\Program Files\\App\\app.exe"
    );
  });

  it("survives empty data", () => {
    expect(extractExecutable("")).toBe("");
    expect(extractExecutable(undefined)).toBe("");
  });
});

describe("isApprovedBinary", () => {
  it("treats an even leading byte as enabled and an odd one as disabled", () => {
    expect(isApprovedBinary("020000000000000000000000")).toBe(true);
    expect(isApprovedBinary("0300000068421 92DB5F4DB01".replace(/\s/g, ""))).toBe(false);
    expect(isApprovedBinary("060000000000000000000000")).toBe(true);
    expect(isApprovedBinary("070000000000000000000000")).toBe(false);
  });

  it("defaults to enabled when the flag is missing or unreadable", () => {
    expect(isApprovedBinary("")).toBe(true);
    expect(isApprovedBinary(undefined)).toBe(true);
    expect(isApprovedBinary("zz")).toBe(true);
  });
});

describe("readAutoStartRegistryState", () => {
  const reader =
    (run: string[], approved?: string[] | Error) =>
    (key: string): string => {
      if (key === RUN_KEY) return exportOf(RUN_KEY, run);
      if (key === APPROVED_KEY) {
        if (approved instanceof Error) throw approved;
        return exportOf(APPROVED_KEY, approved ?? []);
      }
      return "";
    };

  it("reports registered and approved for our quoted entry", () => {
    const state = readAutoStartRegistryState({
      execPath: EXE,
      readKey: reader(
        [runEntry("com.privatetranscribe.app", `"${EXE}" --launch-at-login`)],
        [`"com.privatetranscribe.app"=hex:02,00,00,00,00,00,00,00,00,00,00,00`]
      ),
    });

    expect(state).toEqual({ registered: true, approved: true, name: "com.privatetranscribe.app" });
    expect(registryAutoStartEnabled(state)).toBe(true);
  });

  it("reports registered but not approved when Task Manager disabled it", () => {
    const state = readAutoStartRegistryState({
      execPath: EXE,
      readKey: reader(
        [runEntry("com.privatetranscribe.app", `"${EXE}" --launch-at-login`)],
        [`"com.privatetranscribe.app"=hex:03,00,00,00,68,42,19,2d,b5,f4,db,01`]
      ),
    });

    expect(state.registered).toBe(true);
    expect(state.approved).toBe(false);
    // The user's Task Manager switch wins — this is the case Electron's launchItems missed.
    expect(registryAutoStartEnabled(state)).toBe(false);
  });

  it("finds our entry under C:\\Users\\Søren, and keeps the user's off switch", () => {
    // reg query turned this path into "S\uFFFDren", so the entry never matched: the app
    // re-registered and re-approved itself at every launch and the toggle read off.
    const state = readAutoStartRegistryState({
      execPath: SOREN_EXE,
      readKey: reader(
        [
          runEntry("OneDrive", '"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe" /background'),
          runEntry("com.privatetranscribe.app", `"${SOREN_EXE}" --process-start-args "--hidden"`),
        ],
        [`"com.privatetranscribe.app"=hex:03,00,00,00,00,00,00,00,00,00,00,00`]
      ),
    });

    expect(state).toEqual({ registered: true, approved: false, name: "com.privatetranscribe.app" });
  });

  it("matches an Ωmega user's entry regardless of letter case", () => {
    const exe =
      "C:\\Users\\Ωmega\\AppData\\Local\\Programs\\PrivateTranscribe\\PrivateTranscribe.exe";
    const state = readAutoStartRegistryState({
      execPath: exe.toLowerCase(),
      readKey: reader([runEntry("com.privatetranscribe.app", `"${exe}"`)]),
    });

    expect(state.registered).toBe(true);
    expect(state.approved).toBe(true);
  });

  it("reports not registered when no entry points at our executable", () => {
    const state = readAutoStartRegistryState({
      execPath: EXE,
      readKey: reader([runEntry("Spotify", "C:\\Spotify.exe --autostart")]),
    });

    expect(state).toEqual({ registered: false, approved: false, name: null });
    expect(registryAutoStartEnabled(state)).toBe(false);
  });

  it("matches regardless of slash direction and casing", () => {
    const state = readAutoStartRegistryState({
      execPath: "c:/program files/privatetranscribe/privatetranscribe.exe",
      readKey: reader([runEntry("com.privatetranscribe.app", `"${EXE}" --launch-at-login`)]),
    });

    expect(state.registered).toBe(true);
  });

  it("stays enabled when the StartupApproved key does not exist", () => {
    const state = readAutoStartRegistryState({
      execPath: EXE,
      readKey: reader(
        [runEntry("com.privatetranscribe.app", `"${EXE}" --launch-at-login`)],
        new Error("reg export exited with code 1")
      ),
    });

    expect(state.approved).toBe(true);
  });

  it("returns null when the registry cannot be read, so callers can fall back", () => {
    const state = readAutoStartRegistryState({
      execPath: EXE,
      readKey: () => {
        throw new Error("reg.exe missing");
      },
    });

    expect(state).toBeNull();
    // A null state must never read as "enabled".
    expect(registryAutoStartEnabled(state)).toBe(false);
  });

  it("returns null without an execPath rather than guessing", () => {
    expect(readAutoStartRegistryState({ execPath: "" })).toBeNull();
  });
});

describe("findOtherRunValueOwner", () => {
  const NAME = "com.privatetranscribe.app";
  const TEST_BUILD = "C:\tmp\pt-pack-speakers\win-unpacked\PrivateTranscribe.exe";
  const reader =
    (run: string[], approved: string[] | Error = []) =>
    (key: string): string => {
      if (key === RUN_KEY) return exportOf(RUN_KEY, run);
      if (key === APPROVED_KEY) {
        if (approved instanceof Error) throw approved;
        return exportOf(APPROVED_KEY, approved);
      }
      return "";
    };
  const owner = (
    readKey: (key: string) => string,
    exists: (file: string) => boolean = () => true
  ) => findOtherRunValueOwner({ execPath: TEST_BUILD, valueName: NAME, readKey, exists });

  // The 2026-10-19 case: a packaged test build with a fresh profile found the installed
  // app in the Run value and wrote its own path over it.
  it("names the installed app when a test build would replace its Run value", () => {
    const readKey = reader([runEntry(NAME, `"${EXE}" --launch-at-login --startup-mode=tray`)]);

    expect(owner(readKey, (file) => file === EXE)).toBe(EXE);
  });

  it("keeps a copy the user disabled in Task Manager, even once its folder is gone", () => {
    const readKey = reader(
      [runEntry(NAME, `"${EXE}" --launch-at-login`)],
      [`"${NAME}"=hex:03,00,00,00,00,00,00,00,00,00,00,00`]
    );

    expect(owner(readKey, () => false)).toBe(EXE);
  });

  it("frees a value whose copy was deleted and never disabled", () => {
    const enabled = reader(
      [runEntry(NAME, `"${EXE}" --launch-at-login`)],
      [`"${NAME}"=hex:02,00,00,00,00,00,00,00,00,00,00,00`]
    );
    const neverTouched = reader([runEntry(NAME, `"${EXE}"`)], new Error("missing"));

    expect(owner(enabled, () => false)).toBeNull();
    expect(owner(neverTouched, () => false)).toBeNull();
  });

  it("frees the value when it already points at this build, whatever the casing", () => {
    const readKey = reader([runEntry(NAME, `"${TEST_BUILD.toUpperCase()}" --launch-at-login`)]);

    expect(owner(readKey)).toBeNull();
  });

  it("ignores other apps' values and an empty Run key", () => {
    expect(owner(reader([runEntry("EADM", `"${EXE}" -silent`)]))).toBeNull();
    expect(owner(reader([]))).toBeNull();
  });

  it("returns null when the registry cannot be read, leaving the usual fallback", () => {
    const readKey = () => {
      throw new Error("ERROR: The system was unable to find the specified registry key");
    };

    expect(owner(readKey)).toBeNull();
  });
});

describe.runIf(process.platform === "win32")("defaultRegReader on the real registry", () => {
  // A scratch key of its own, so the test never touches the real Run entries.
  const key = `HKCU\\Software\\PrivateTranscribe-test-${randomUUID()}`;
  const reg = (args: string[]) => execFileSync("reg", args, { stdio: "ignore", windowsHide: true });

  afterAll(() => {
    try {
      reg(["delete", key, "/f"]);
    } catch {
      // Never created.
    }
  });

  it("returns Søren, Ωmega and 李雷 exactly as stored", () => {
    const exe =
      "C:\\Users\\Søren Ωmega 李雷\\AppData\\Local\\Programs\\PrivateTranscribe\\PrivateTranscribe.exe";
    const data = `"${exe}" --process-start-args "--hidden"`;
    reg(["add", key, "/v", "com.privatetranscribe.app", "/t", "REG_SZ", "/d", data, "/f"]);
    reg(["add", key, "/v", "Ωmega", "/t", "REG_BINARY", "/d", "030000000000000000000000", "/f"]);

    expect(parseRegExport(defaultRegReader(key))).toEqual([
      { name: "com.privatetranscribe.app", type: "REG_SZ", data },
      { name: "Ωmega", type: "REG_BINARY", data: "030000000000000000000000" },
    ]);
  });

  it("throws for a missing key, which callers read as unreadable", () => {
    expect(() => defaultRegReader(`${key}\\Missing`)).toThrow();
  });
});
