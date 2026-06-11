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
      args: ["C:/Projects/PrivateTranscribe"],
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
      args: [],
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
      args: ["C:/Projects/PrivateTranscribe"],
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
});
