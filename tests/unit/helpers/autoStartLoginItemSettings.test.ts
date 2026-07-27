import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  buildAutoStartLaunchOptions,
  buildAutoStartSetOptions,
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

describe("resolveAutoStartEnabled", () => {
  it("reports off when Windows has the run key but Task Manager disabled it", () => {
    expect(
      resolveAutoStartEnabled({ openAtLogin: true, executableWillLaunchAtLogin: false }, "win32")
    ).toBe(false);
  });

  it("reports on for older Windows installs registered without startup-mode args", () => {
    // openAtLogin is false because the args do not match, but the executable still runs.
    expect(
      resolveAutoStartEnabled({ openAtLogin: false, executableWillLaunchAtLogin: true }, "win32")
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
