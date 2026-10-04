import fs from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Only official release builds may check the update feed. An installer built
 * from source is packaged and carries app-update.yml exactly like a release, so
 * neither of those can tell the two apart; the official-build flag does.
 */

const require = createRequire(import.meta.url);

type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleWithLoader = Module as unknown as { _load: ModuleLoader };
const originalLoad = moduleWithLoader._load;

const autoUpdater = {
  setFeedURL: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
};

let appPath = "";

moduleWithLoader._load = (request, parent, isMain) => {
  if (request === "electron") {
    return {
      app: {
        isPackaged: true,
        getAppPath: () => appPath,
        getVersion: () => "0.20.2",
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
const debugLogger = require("../../src/helpers/debugLogger");

const OVERRIDE_ENV = "PRIVATETRANSCRIBE_OFFICIAL_BUILD";
const FEED_URL = "https://updates.privatetranscribe.com/win";
const UNOFFICIAL_MESSAGE =
  "Updates are off in copies built from source. Official builds are at privatetranscribe.com.";

type ProcessWithResources = NodeJS.Process & { resourcesPath?: string };
const electronProcess = process as ProcessWithResources;
const saved = {
  override: process.env[OVERRIDE_ENV],
  nodeEnv: process.env.NODE_ENV,
  resourcesPath: electronProcess.resourcesPath,
};
let resourcesPath = "";

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function writePackageJson(fields: Record<string, unknown>) {
  fs.writeFileSync(
    path.join(appPath, "package.json"),
    JSON.stringify({ name: "privatetranscribe", version: "0.20.2", ...fields })
  );
}

/** What electron-builder writes next to every NSIS install, official or not. */
function writeUpdateConfig() {
  fs.writeFileSync(
    path.join(resourcesPath, "app-update.yml"),
    `provider: generic\nurl: ${FEED_URL}\n`
  );
}

beforeEach(() => {
  appPath = fs.mkdtempSync(path.join(os.tmpdir(), "pt-updater-app-"));
  resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), "pt-updater-resources-"));
  electronProcess.resourcesPath = resourcesPath;
  process.env.NODE_ENV = "production";
  delete process.env[OVERRIDE_ENV];
  autoUpdater.checkForUpdates.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(appPath, { recursive: true, force: true });
  fs.rmSync(resourcesPath, { recursive: true, force: true });
  electronProcess.resourcesPath = saved.resourcesPath;
  restoreEnv(OVERRIDE_ENV, saved.override);
  restoreEnv("NODE_ENV", saved.nodeEnv);
});

afterAll(() => {
  moduleWithLoader._load = originalLoad;
});

describe("app updates in a copy built from source", () => {
  it("never configures or contacts the update feed, and says why once", async () => {
    vi.useFakeTimers();
    writePackageJson({});
    writeUpdateConfig();
    const info = vi.spyOn(debugLogger, "info");

    const manager = new UpdateManager();
    manager.checkForUpdatesOnStartup();
    vi.advanceTimersByTime(60_000);

    await expect(manager.checkForUpdates()).resolves.toMatchObject({
      updateAvailable: false,
      automaticUpdatesAvailable: false,
      message: UNOFFICIAL_MESSAGE,
    });
    await expect(manager.downloadUpdate()).resolves.toMatchObject({ success: false });
    await expect(manager.installUpdate()).resolves.toMatchObject({ success: false });
    await expect(manager.getUpdateStatus()).resolves.toMatchObject({
      automaticUpdatesAvailable: false,
      message: UNOFFICIAL_MESSAGE,
    });

    expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(autoUpdater.on).not.toHaveBeenCalled();
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toContain("privatetranscribeOfficialBuild");
  });

  it("still reports how the copy was built", async () => {
    writePackageJson({});
    await expect(new UpdateManager().getAppVersion()).resolves.toEqual({
      version: "0.20.2",
      buildType: "unpacked",
    });

    writeUpdateConfig();
    await expect(new UpdateManager().getAppVersion()).resolves.toEqual({
      version: "0.20.2",
      buildType: "installed",
    });
  });
});

describe("app updates in an official build", () => {
  it("follows the update feed and checks on startup", () => {
    vi.useFakeTimers();
    writePackageJson({ privatetranscribeOfficialBuild: true });
    writeUpdateConfig();

    const manager = new UpdateManager();
    expect(autoUpdater.setFeedURL).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "generic", url: FEED_URL })
    );

    manager.checkForUpdatesOnStartup();
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("treats the test override as an official build", () => {
    writePackageJson({});
    writeUpdateConfig();
    process.env[OVERRIDE_ENV] = "1";

    new UpdateManager();

    expect(autoUpdater.setFeedURL).toHaveBeenCalledTimes(1);
  });
});
