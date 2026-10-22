import fs from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * electron-updater installs the file it downloaded, whatever a later check
 * found. The app's own state has to follow that: a newer release found after
 * a download is not the one that is ready, and a release the feed no longer
 * offers must not install itself on quit.
 */

const require = createRequire(import.meta.url);

type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleWithLoader = Module as unknown as { _load: ModuleLoader };
const originalLoad = moduleWithLoader._load;

const handlers = new Map<string, (info?: unknown) => void>();
const autoUpdater: Record<string, any> = {
  setFeedURL: vi.fn(),
  on: vi.fn((event: string, handler: (info?: unknown) => void) => handlers.set(event, handler)),
  removeListener: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn().mockResolvedValue(undefined),
  quitAndInstall: vi.fn(),
};

let appPath = "";

moduleWithLoader._load = (request, parent, isMain) => {
  if (request === "electron") {
    return {
      app: {
        isPackaged: true,
        getAppPath: () => appPath,
        getVersion: () => "0.24.1",
        isReady: () => false,
      },
    };
  }
  if (request === "electron-updater") {
    return { autoUpdater };
  }
  return originalLoad(request, parent, isMain);
};

const UpdateManager = require("../../src/updater");

type ProcessWithResources = NodeJS.Process & { resourcesPath?: string };
const electronProcess = process as ProcessWithResources;
const saved = { nodeEnv: process.env.NODE_ENV, resourcesPath: electronProcess.resourcesPath };
let resourcesPath = "";

const emit = (event: string, info?: unknown) => handlers.get(event)?.(info);

beforeEach(() => {
  handlers.clear();
  autoUpdater.downloadUpdate.mockClear();
  appPath = fs.mkdtempSync(path.join(os.tmpdir(), "pt-updater-app-"));
  resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), "pt-updater-resources-"));
  electronProcess.resourcesPath = resourcesPath;
  process.env.NODE_ENV = "production";
  fs.writeFileSync(
    path.join(appPath, "package.json"),
    JSON.stringify({ name: "privatetranscribe", version: "0.24.1", privatetranscribeOfficialBuild: true })
  );
  fs.writeFileSync(
    path.join(resourcesPath, "app-update.yml"),
    "provider: generic\nurl: https://updates.privatetranscribe.com/win\n"
  );
});

afterEach(() => {
  fs.rmSync(appPath, { recursive: true, force: true });
  fs.rmSync(resourcesPath, { recursive: true, force: true });
  electronProcess.resourcesPath = saved.resourcesPath;
  if (saved.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = saved.nodeEnv;
});

afterAll(() => {
  moduleWithLoader._load = originalLoad;
});

describe("a downloaded update and a later check", () => {
  it("offers the newer release found after a download instead of calling it ready", async () => {
    const manager = new UpdateManager();
    emit("update-available", { version: "0.25.0" });
    emit("update-downloaded", { version: "0.25.0" });

    emit("update-available", { version: "0.25.1" });

    // Install would run the 0.25.0 file under a "0.25.1 is ready" label.
    await expect(manager.getUpdateStatus()).resolves.toMatchObject({ updateDownloaded: false });
    await expect(manager.downloadUpdate()).resolves.toMatchObject({
      message: "Update download started",
    });
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it("keeps a download ready when the check finds the same release again", async () => {
    const manager = new UpdateManager();
    emit("update-available", { version: "0.25.0" });
    emit("update-downloaded", { version: "0.25.0" });

    emit("update-available", { version: "0.25.0" });

    await expect(manager.getUpdateStatus()).resolves.toMatchObject({ updateDownloaded: true });
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it("does not install a downloaded release on quit once the feed stops offering it", () => {
    new UpdateManager();
    emit("update-available", { version: "0.25.0" });
    emit("update-downloaded", { version: "0.25.0" });

    emit("update-not-available", { version: "0.24.1" });

    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it("installs on quit again after the next download", () => {
    new UpdateManager();
    emit("update-downloaded", { version: "0.25.0" });
    emit("update-not-available", { version: "0.24.1" });

    emit("update-downloaded", { version: "0.25.2" });

    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
  });
});

describe("the Settings update state", () => {
  it("drops the ready state when a newer release than the downloaded one is found", async () => {
    const { updateAvailableState } = await import("../../src/hooks/useUpdater");
    const downloaded = {
      status: { updateAvailable: true, updateDownloaded: true, isDevelopment: false },
      info: { version: "0.25.0" },
      downloadProgress: 100,
      isChecking: false,
      isDownloading: false,
      isInstalling: false,
      error: null,
    };

    expect(updateAvailableState(downloaded, { version: "0.25.1" })).toMatchObject({
      status: { updateAvailable: true, updateDownloaded: false },
      info: { version: "0.25.1" },
      downloadProgress: 0,
    });
    expect(updateAvailableState(downloaded, { version: "0.25.0" })).toMatchObject({
      status: { updateDownloaded: true },
    });
  });
});
