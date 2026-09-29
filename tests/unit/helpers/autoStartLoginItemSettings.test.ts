import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  buildAutoStartLaunchOptions,
  buildAutoStartSetOptions,
  canRegisterAutoStart,
  isEphemeralAppPath,
  findAutoStartLaunchItem,
  getAutoStartApprovalState,
  resolveAutoStartEnabled,
} = require("../../../src/helpers/autoStartLoginItemSettings");

const WIN_EXE = "C:/Users/me/AppData/Local/Programs/PrivateTranscribe/PrivateTranscribe.exe";

describe("auto-start login item settings", () => {
  it("registers the Electron binary plus app path in Windows development", () => {
    expect(
      buildAutoStartSetOptions({
        enabled: true,
        platform: "win32",
        isPackaged: false,
        execPath: "C:/Users/dev/AppData/Local/electron/electron.exe",
        appPath: "C:/Projects/PrivateTranscribe",
      })
    ).toEqual({
      openAtLogin: true,
      enabled: true,
      path: "C:/Users/dev/AppData/Local/electron/electron.exe",
      args: ["C:/Projects/PrivateTranscribe", "--launch-at-login", "--startup-mode=tray"],
    });
  });

  it("uses the packaged executable without dev args on Windows production", () => {
    expect(
      buildAutoStartSetOptions({
        enabled: true,
        platform: "win32",
        isPackaged: true,
        execPath: WIN_EXE,
        appPath: "C:/unused/app.asar",
      })
    ).toEqual({
      openAtLogin: true,
      enabled: true,
      path: WIN_EXE,
      args: ["--launch-at-login", "--startup-mode=tray"],
    });
  });

  it("uses identical launch options when reading Windows status", () => {
    expect(
      buildAutoStartLaunchOptions({
        platform: "win32",
        isPackaged: false,
        execPath: "C:/electron/electron.exe",
        appPath: "C:/Projects/PrivateTranscribe",
      })
    ).toEqual({
      path: "C:/electron/electron.exe",
      args: ["C:/Projects/PrivateTranscribe", "--launch-at-login", "--startup-mode=tray"],
    });
  });

  it("keeps openAsHidden scoped to macOS", () => {
    expect(buildAutoStartSetOptions({ enabled: true, platform: "darwin" })).toEqual({
      openAtLogin: true,
      openAsHidden: true,
    });
    expect(buildAutoStartSetOptions({ enabled: true, platform: "linux" })).toEqual({
      openAtLogin: true,
    });
  });

  it("stores the selected Windows login launch mode in startup args", () => {
    expect(
      buildAutoStartSetOptions({
        enabled: true,
        platform: "win32",
        isPackaged: true,
        execPath: "C:/PrivateTranscribe.exe",
        launchMode: "minimized",
      })
    ).toEqual({
      openAtLogin: true,
      enabled: true,
      path: "C:/PrivateTranscribe.exe",
      args: ["--launch-at-login", "--startup-mode=minimized"],
    });
  });

  it("carries an existing Task Manager disable through a launch-mode rewrite", () => {
    // Electron's `enabled` option defaults to true, which would re-approve the entry.
    expect(
      buildAutoStartSetOptions({
        enabled: true,
        startupApproved: false,
        platform: "win32",
        isPackaged: true,
        execPath: WIN_EXE,
        launchMode: "window",
      })
    ).toMatchObject({
      openAtLogin: true,
      enabled: false,
    });
  });

  it("never sends the Windows-only approval flag to other platforms", () => {
    expect(
      buildAutoStartSetOptions({ enabled: true, startupApproved: false, platform: "darwin" })
    ).not.toHaveProperty("enabled");
  });
});

describe("temporary app paths", () => {
  // The real entry this guard exists for: a dev run launched out of an agent session's
  // scratch copy wrote `electron.exe <temp path> --launch-at-login` into the Run key, and
  // every login after the temp folder was cleaned up showed Electron's error dialog.
  const SCRATCH_PATH =
    "C:\\Users\\USERNA~1\\AppData\\Local\\Temp\\claude\\c--Projects-PrivateTranscribe\\b58a70dd\\scratchpad";

  it("recognises Windows temp locations in either slash or short-name form", () => {
    expect(isEphemeralAppPath(SCRATCH_PATH, {})).toBe(true);
    expect(isEphemeralAppPath("C:/Users/me/AppData/Local/Temp/build/app", {})).toBe(true);
    expect(isEphemeralAppPath("C:\\Windows\\Temp\\PrivateTranscribe", {})).toBe(true);
  });

  it("recognises whatever TEMP points at, even outside the known locations", () => {
    expect(isEphemeralAppPath("D:/scratch/checkout", { TEMP: "D:\\scratch" })).toBe(true);
    expect(isEphemeralAppPath("D:/projects/checkout", { TEMP: "D:\\scratch" })).toBe(false);
  });

  it("leaves ordinary checkouts alone", () => {
    expect(isEphemeralAppPath("C:/Projects/PrivateTranscribe", {})).toBe(false);
    // "temp" has to be a directory of its own, not a fragment of a longer name.
    expect(isEphemeralAppPath("C:/Projects/template/app", {})).toBe(false);
    expect(isEphemeralAppPath("C:/Projects/tmp-tools/app", {})).toBe(false);
    expect(isEphemeralAppPath("", {})).toBe(false);
  });

  it("blocks registering a Windows dev run from a temp path", () => {
    expect(
      canRegisterAutoStart({
        platform: "win32",
        isPackaged: false,
        appPath: SCRATCH_PATH,
        env: {},
      })
    ).toBe(false);
  });

  it("still allows packaged installs and normal dev checkouts", () => {
    // Packaged builds never put the app path in the args, so a temp install directory
    // cannot rot the Run key the same way.
    expect(
      canRegisterAutoStart({
        platform: "win32",
        isPackaged: true,
        appPath: SCRATCH_PATH,
        env: {},
      })
    ).toBe(true);
    expect(
      canRegisterAutoStart({
        platform: "win32",
        isPackaged: false,
        appPath: "C:/Projects/PrivateTranscribe",
        env: {},
      })
    ).toBe(true);
  });

  it("only applies to Windows, the one platform that registers the app path", () => {
    expect(
      canRegisterAutoStart({
        platform: "darwin",
        isPackaged: false,
        appPath: "/var/folders/xx/scratch/app",
        env: {},
      })
    ).toBe(true);
  });
});

describe("resolveAutoStartEnabled", () => {
  // Windows truth now comes from readAutoStartRegistryState. This helper is only the
  // fallback for when the registry cannot be read, so it must never trust
  // executableWillLaunchAtLogin: on a real install that field reports true while the Run
  // key holds no entry, which pinned the settings toggle to "on" and made auto-start
  // impossible to switch on.
  it("ignores executableWillLaunchAtLogin on Windows", () => {
    expect(
      resolveAutoStartEnabled({ openAtLogin: false, executableWillLaunchAtLogin: true }, "win32")
    ).toBe(false);
    expect(
      resolveAutoStartEnabled({ openAtLogin: true, executableWillLaunchAtLogin: false }, "win32")
    ).toBe(true);
  });

  it("falls back to openAtLogin on macOS and Linux", () => {
    expect(resolveAutoStartEnabled({ openAtLogin: true }, "darwin")).toBe(true);
    expect(resolveAutoStartEnabled({ openAtLogin: false }, "linux")).toBe(false);
    expect(resolveAutoStartEnabled(null, "darwin")).toBe(false);
  });
});

describe("getAutoStartApprovalState", () => {
  const launchItems = [
    { name: "OtherApp", path: "C:\\Program Files\\OtherApp\\other.exe", enabled: true },
    { name: "PrivateTranscribe", path: WIN_EXE.replace(/\//g, "\\"), enabled: false },
  ];

  it("matches our executable regardless of slash direction and casing", () => {
    expect(getAutoStartApprovalState({ launchItems }, WIN_EXE.toUpperCase())).toBe(false);
  });

  it("returns true when the entry is startup approved", () => {
    expect(
      getAutoStartApprovalState({ launchItems: [{ path: WIN_EXE, enabled: true }] }, WIN_EXE)
    ).toBe(true);
  });

  it("returns null when this executable has no registry entry", () => {
    expect(getAutoStartApprovalState({ launchItems }, "C:/somewhere/else.exe")).toBeNull();
    expect(getAutoStartApprovalState({}, WIN_EXE)).toBeNull();
    expect(findAutoStartLaunchItem(undefined, WIN_EXE)).toBeNull();
  });
});
