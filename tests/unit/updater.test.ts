import Module, { createRequire } from "node:module";
import { afterAll, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const electronMocks = {
  getVersion: vi.fn(() => "0.17.1"),
};

type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleWithLoader = Module as unknown as { _load: ModuleLoader };
const originalLoad = moduleWithLoader._load;

moduleWithLoader._load = (request, parent, isMain) => {
  if (request === "electron") {
    return { app: { getVersion: electronMocks.getVersion } };
  }
  if (request === "electron-updater") {
    return { autoUpdater: {} };
  }
  return originalLoad(request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const UpdateManager = require("../../src/updater");

afterAll(() => {
  moduleWithLoader._load = originalLoad;
});

function managerWithRuntime(updateRuntime: {
  isDevelopment: boolean;
  manualInstallRequired: boolean;
}) {
  const manager = Object.create(UpdateManager.prototype);
  manager.updateRuntime = updateRuntime;
  return manager;
}

describe("UpdateManager app version metadata", () => {
  it.each([
    {
      name: "development",
      runtime: { isDevelopment: true, manualInstallRequired: false },
      buildType: "development",
    },
    {
      name: "unpacked",
      runtime: { isDevelopment: false, manualInstallRequired: true },
      buildType: "unpacked",
    },
    {
      name: "installed",
      runtime: { isDevelopment: false, manualInstallRequired: false },
      buildType: "installed",
    },
  ])("reports an $name build", async ({ runtime, buildType }) => {
    await expect(managerWithRuntime(runtime).getAppVersion()).resolves.toEqual({
      version: "0.17.1",
      buildType,
    });
  });
});
