import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { resolveUpdateRuntime } = require("../../../src/helpers/updateRuntime");

describe("update runtime availability", () => {
  it("keeps normal installed builds on the automatic updater path", () => {
    const resourcesPath = path.join("C:", "Program Files", "PrivateTranscribe", "resources");
    const configExists = vi.fn(() => true);

    expect(
      resolveUpdateRuntime({
        isDevelopment: false,
        isPackaged: true,
        resourcesPath,
        configExists,
      })
    ).toEqual({
      automaticUpdatesAvailable: true,
      isDevelopment: false,
      manualInstallRequired: false,
      updateConfigPath: path.join(resourcesPath, "app-update.yml"),
    });
  });

  it("requires the official installer when app-update.yml is missing", () => {
    const resourcesPath = path.join(
      "C:",
      "Users",
      "KT",
      "Documents",
      "GitHub",
      "PrivateTranscribe",
      "dist",
      "win-unpacked",
      "resources"
    );

    expect(
      resolveUpdateRuntime({
        isDevelopment: false,
        isPackaged: true,
        resourcesPath,
        configExists: () => false,
      })
    ).toMatchObject({
      automaticUpdatesAvailable: false,
      isDevelopment: false,
      manualInstallRequired: true,
      manualInstallUrl: "https://privatetranscribe.com/download/windows",
      message: expect.stringContaining("official installer"),
    });
  });

  it("does not enable automatic updates in development", () => {
    expect(
      resolveUpdateRuntime({
        isDevelopment: true,
        isPackaged: false,
        resourcesPath: "/tmp/resources",
        configExists: () => false,
      })
    ).toMatchObject({
      automaticUpdatesAvailable: false,
      isDevelopment: true,
      manualInstallRequired: false,
    });
  });
});
