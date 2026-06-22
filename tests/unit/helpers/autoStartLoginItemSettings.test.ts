import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  buildAutoStartLaunchOptions,
  buildAutoStartSetOptions,
} = require("../../../src/helpers/autoStartLoginItemSettings");

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
        execPath: "C:/Users/me/AppData/Local/Programs/PrivateTranscribe/PrivateTranscribe.exe",
        appPath: "C:/unused/app.asar",
      })
    ).toEqual({
      openAtLogin: true,
      path: "C:/Users/me/AppData/Local/Programs/PrivateTranscribe/PrivateTranscribe.exe",
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
      path: "C:/PrivateTranscribe.exe",
      args: ["--launch-at-login", "--startup-mode=minimized"],
    });
  });
});
