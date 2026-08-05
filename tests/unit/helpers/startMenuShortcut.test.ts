import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { resolveStartMenuShortcutPaths } = require("../../../src/helpers/startMenuShortcut");

describe("start menu shortcut paths", () => {
  it("targets the per-user Programs folder and the truncated name Windows invents", () => {
    const { shortcutPath, strayPath } = resolveStartMenuShortcutPaths({
      appDataPath: path.join("C:", "Users", "me", "AppData", "Roaming"),
      appName: "PrivateTranscribe",
    });

    expect(shortcutPath).toContain(path.join("Start Menu", "Programs"));
    expect(path.basename(shortcutPath)).toBe("PrivateTranscribe.lnk");
    expect(path.basename(strayPath)).toBe("PrivateTranscrib.lnk");
    expect(path.dirname(strayPath)).toBe(path.dirname(shortcutPath));
  });

  it("has no stray shortcut to clean up for a single-character name", () => {
    expect(
      resolveStartMenuShortcutPaths({ appDataPath: "C:\\Roaming", appName: "P" }).strayPath
    ).toBeNull();
  });
});
