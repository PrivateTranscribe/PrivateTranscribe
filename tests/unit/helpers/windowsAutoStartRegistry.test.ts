import { describe, expect, it } from "vitest";

const {
  RUN_KEY,
  APPROVED_KEY,
  parseRegQuery,
  extractExecutable,
  isApprovedBinary,
  readAutoStartRegistryState,
  registryAutoStartEnabled,
} = require("../../../src/helpers/windowsAutoStartRegistry");

const EXE = "C:\\Program Files\\PrivateTranscribe\\PrivateTranscribe.exe";

const runOutput = (rows: string) =>
  ["", `HKEY_CURRENT_USER\\${RUN_KEY.replace("HKCU\\", "")}`, rows, ""].join("\r\n");

describe("parseRegQuery", () => {
  it("splits reg.exe's three columns", () => {
    const rows = parseRegQuery(
      runOutput(
        `    Spotify    REG_SZ    C:\\Spotify.exe --autostart\r\n    Steam    REG_SZ    "C:\\steam.exe" -silent`
      )
    );

    expect(rows).toEqual([
      { name: "Spotify", type: "REG_SZ", data: "C:\\Spotify.exe --autostart" },
      { name: "Steam", type: "REG_SZ", data: '"C:\\steam.exe" -silent' },
    ]);
  });

  it("ignores key headers and blank lines", () => {
    expect(parseRegQuery("\r\nHKEY_CURRENT_USER\\Software\r\n\r\n")).toEqual([]);
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
    (run: string, approved?: string | Error) =>
    (key: string): string => {
      if (key === RUN_KEY) return run;
      if (key === APPROVED_KEY) {
        if (approved instanceof Error) throw approved;
        return approved ?? "";
      }
      return "";
    };

  it("reports registered and approved for our quoted entry", () => {
    const state = readAutoStartRegistryState({
      execPath: EXE,
      readKey: reader(
        runOutput(`    com.privatetranscribe.app    REG_SZ    "${EXE}" --launch-at-login`),
        `    com.privatetranscribe.app    REG_BINARY    020000000000000000000000`
      ),
    });

    expect(state).toEqual({ registered: true, approved: true, name: "com.privatetranscribe.app" });
    expect(registryAutoStartEnabled(state)).toBe(true);
  });

  it("reports registered but not approved when Task Manager disabled it", () => {
    const state = readAutoStartRegistryState({
      execPath: EXE,
      readKey: reader(
        runOutput(`    com.privatetranscribe.app    REG_SZ    "${EXE}" --launch-at-login`),
        `    com.privatetranscribe.app    REG_BINARY    030000006842192DB5F4DB01`
      ),
    });

    expect(state.registered).toBe(true);
    expect(state.approved).toBe(false);
    // The user's Task Manager switch wins — this is the case Electron's launchItems missed.
    expect(registryAutoStartEnabled(state)).toBe(false);
  });

  it("reports not registered when no entry points at our executable", () => {
    const state = readAutoStartRegistryState({
      execPath: EXE,
      readKey: reader(runOutput(`    Spotify    REG_SZ    C:\\Spotify.exe --autostart`)),
    });

    expect(state).toEqual({ registered: false, approved: false, name: null });
    expect(registryAutoStartEnabled(state)).toBe(false);
  });

  it("matches regardless of slash direction and casing", () => {
    const state = readAutoStartRegistryState({
      execPath: "c:/program files/privatetranscribe/privatetranscribe.exe",
      readKey: reader(
        runOutput(`    com.privatetranscribe.app    REG_SZ    "${EXE}" --launch-at-login`)
      ),
    });

    expect(state.registered).toBe(true);
  });

  it("stays enabled when the StartupApproved key does not exist", () => {
    const state = readAutoStartRegistryState({
      execPath: EXE,
      readKey: reader(
        runOutput(`    com.privatetranscribe.app    REG_SZ    "${EXE}" --launch-at-login`),
        new Error("ERROR: The system was unable to find the specified registry key")
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
