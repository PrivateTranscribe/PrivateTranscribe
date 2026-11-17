import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { BETA_FEATURES_KEY } from "../../src/utils/betaFeatures";
import { expect, test } from "./fixtures/electron-app";
import {
  catchInstance,
  configureLocalWhisperDictation,
  endLeftoverEngines,
  readMainLog,
  readPastes,
  recordingHalo,
  recordPastes,
  tapMainLog,
  toggleDictation,
} from "./fixtures/app-drive";
import { unlockTesterAccess } from "./fixtures/tester-access";

/**
 * A local AI model is several GB, so people start the download and go to
 * another page. The model used to be switched on only if the picker was still
 * on screen when the download ended. After leaving the page the model sat
 * downloaded but unused, and dictation was pasted without cleanup.
 */

const localId = "qwen3.8-2b-distill-q4_k_m";

test.use({
  useThrowawayHome: true,
  appEnv: { PRIVATETRANSCRIBE_DIAG_DISABLE_OVERLAY_WINDOW: "1" },
});

/** A stand-in download that ends when the test says so. */
async function fakeSlowDownload(electronApp: ElectronApplication) {
  await electronApp.evaluate(({ ipcMain }, modelId) => {
    let downloaded = false;
    const state = globalThis as unknown as { __finishDownload?: () => void };
    ipcMain.removeHandler("model-get-all");
    ipcMain.handle("model-get-all", () => [{ id: modelId, isDownloaded: downloaded }]);
    ipcMain.removeHandler("model-download");
    ipcMain.handle("model-download", async (event, id) => {
      if (id !== modelId) throw new Error("Unexpected model");
      event.sender.send("model-download-progress", {
        modelId: id,
        progress: 50,
        downloadedSize: 656082112,
        totalSize: 1312164224,
      });
      await new Promise<void>((resolve) => {
        state.__finishDownload = resolve;
      });
      downloaded = true;
      return { success: true };
    });
  }, localId);
}

async function finishDownload(electronApp: ElectronApplication) {
  await electronApp.evaluate(() => {
    (globalThis as unknown as { __finishDownload: () => void }).__finishDownload();
  });
}

async function startLocalDownload(page: Page, electronApp: ElectronApplication) {
  await unlockTesterAccess(page);
  await page.getByRole("button", { name: "AI Enhancement", exact: true }).click();
  await page.getByRole("button", { name: "Enable AI enhancement" }).click();
  await page.getByRole("combobox", { name: "Enhance using", exact: true }).click();
  await page.getByRole("option", { name: "Local model", exact: true }).click();
  await page.getByRole("button", { name: "Download", exact: true }).click();
  // The stand-in download is under way once the main process holds its end.
  await expect
    .poll(() =>
      electronApp.evaluate(
        () =>
          typeof (globalThis as unknown as { __finishDownload?: unknown }).__finishDownload ===
          "function"
      )
    )
    .toBe(true);
}

test("a local AI model that finishes downloading on another page is switched on", async ({
  controlPanel: page,
  electronApp,
}) => {
  await fakeSlowDownload(electronApp);
  await startLocalDownload(page, electronApp);

  // Leave the page while the model is still downloading.
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByRole("button", { name: "Try cleanup", exact: true })).toHaveCount(0);

  await finishDownload(electronApp);

  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("reasoningModel")))
    .toBe(localId);

  // Back on the page the model is the active one and can be tried.
  await page.getByRole("button", { name: "AI Enhancement", exact: true }).click();
  await expect(page.getByRole("button", { name: "Try cleanup", exact: true })).toBeEnabled();
});

test("a local AI model is not switched on after the user moved to an API provider", async ({
  controlPanel: page,
  electronApp,
}) => {
  await fakeSlowDownload(electronApp);
  await startLocalDownload(page, electronApp);

  await page.getByRole("combobox", { name: "Enhance using", exact: true }).click();
  await page.getByRole("option", { name: "API provider", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("reasoningProvider")))
    .not.toBe("qwen");

  await finishDownload(electronApp);
  // The download's own call has returned once the model is listed as downloaded.
  await expect
    .poll(() =>
      page.evaluate(() => window.electronAPI.modelGetAll().then((all) => all[0].isDownloaded))
    )
    .toBe(true);

  // Give the page a moment to act on the finished download, wrongly or not.
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => localStorage.getItem("reasoningModel"))).not.toBe(localId);
});

/**
 * The same walk with the model's real file, to see the dictation overlay pick
 * the model up. Only the transfer is a stand-in: when the "download" ends, this
 * PC's own copy of the model is linked into the throwaway home, so the app
 * finds a real file where a download would have put it. The overlay is not
 * reloaded after that. Its next dictation has to be cleaned up by the real
 * llama-server with that file.
 */
test.describe("with the model's real file", () => {
  const MODEL_FILE = "Qwen3.8-2B-Q4_K_M.gguf";
  const modelOnThisPc = path.join(
    os.homedir(),
    ".cache",
    "PrivateTranscribe",
    "models",
    MODEL_FILE
  );

  test.use({
    fakeAudioCaptureFile: path.resolve(__dirname, "..", "fixtures", "dictation", "banana.wav"),
    seedRealWhisperModels: ["base"],
    appEnv: { WHISPER_FORCE_CPU: "true" },
  });

  type Live = { __ptE2eLive: Record<string, any>; __finishDownload?: () => void };

  /** A download that puts the real file in place when the test says so. */
  async function downloadDeliversRealFile(electronApp: ElectronApplication, fakeHome: string) {
    const dest = path.join(fakeHome, ".cache", "PrivateTranscribe", "models", MODEL_FILE);
    await electronApp.evaluate(
      ({ ipcMain }, { modelId, source, dest }) => {
        const state = globalThis as unknown as Live;
        const nodeFs = process.getBuiltinModule("node:fs");
        const nodePath = process.getBuiltinModule("node:path");
        ipcMain.removeHandler("model-download");
        ipcMain.handle("model-download", async (event, id) => {
          if (id !== modelId) throw new Error("Unexpected model");
          const totalSize = nodeFs.statSync(source).size;
          event.sender.send("model-download-progress", {
            modelId: id,
            progress: 50,
            downloadedSize: Math.round(totalSize / 2),
            totalSize,
          });
          await new Promise<void>((resolve) => {
            state.__finishDownload = resolve;
          });
          nodeFs.mkdirSync(nodePath.dirname(dest), { recursive: true });
          try {
            nodeFs.linkSync(source, dest);
          } catch {
            nodeFs.copyFileSync(source, dest);
          }
          return { success: true, path: dest };
        });
      },
      { modelId: localId, source: modelOnThisPc, dest }
    );
  }

  const cleanupEngine = (electronApp: ElectronApplication) =>
    electronApp.evaluate(() => {
      const manager = (globalThis as unknown as Live).__ptE2eLive.llamaServer;
      return {
        pid: (manager?.process?.pid ?? null) as number | null,
        modelPath: (manager?.modelPath ?? null) as string | null,
      };
    });

  const pids: Array<number | null> = [];
  test.afterEach(async ({ electronApp }) => {
    pids.push((await cleanupEngine(electronApp).catch(() => null))?.pid ?? null);
    endLeftoverEngines(pids.splice(0));
  });

  test("the next dictation is cleaned up by a model that finished downloading on another page", async ({
    controlPanel: page,
    overlayWindow,
    electronApp,
    fakeHomeDir,
  }) => {
    test.setTimeout(600_000);
    if (!fakeHomeDir)
      throw new Error("this test needs the throwaway home the whisper seed creates");
    expect(
      fs.existsSync(modelOnThisPc),
      `the cleanup model is not on this machine. Download "${localId}" in the app first. Missing: ${modelOnThisPc}`
    ).toBe(true);

    await recordPastes(electronApp);
    await tapMainLog(electronApp);
    await catchInstance(electronApp, {
      key: "llamaServer",
      modulePath: "src/helpers/llamaServer.js",
      method: "start",
    });
    await downloadDeliversRealFile(electronApp, fakeHomeDir);

    // The overlay starts as a new user's: dictation set up, no cleanup model.
    await configureLocalWhisperDictation(overlayWindow, { [BETA_FEATURES_KEY]: "true" });
    expect(await overlayWindow.evaluate(() => localStorage.getItem("reasoningModel") || "")).toBe(
      ""
    );

    await startLocalDownload(page, electronApp);
    await page.getByRole("button", { name: "History", exact: true }).click();
    await finishDownload(electronApp);
    // Soft, so a model that was never switched on still gets its dictation
    // below and the run shows what the user is left with.
    await expect
      .configure({ soft: true })
      .poll(() => page.evaluate(() => localStorage.getItem("reasoningModel")))
      .toBe(localId);

    // One dictation from the overlay, which has not been reloaded since. Two
    // passes of the six-second clip, so one whole sentence is always in it.
    await toggleDictation(electronApp);
    await expect(recordingHalo(overlayWindow)).toHaveCount(1, { timeout: 30_000 });
    await overlayWindow.waitForTimeout(12_000);
    await toggleDictation(electronApp);
    await expect
      .poll(async () => (await readPastes(electronApp)).length, { timeout: 300_000 })
      .toBe(1);

    const stages = (await readMainLog(electronApp)).map((line) => line.message);
    expect(
      stages.filter((stage) => stage === "LOCAL_BRIDGE_SUCCESS"),
      "the dictation was pasted without a cleanup by the local model"
    ).toHaveLength(1);
    expect(stages).not.toContain("LOCAL_BRIDGE_ERROR");
    // The engine loaded the file the "download" delivered, not another copy.
    expect(path.resolve((await cleanupEngine(electronApp)).modelPath ?? "")).toBe(
      path.join(fakeHomeDir, ".cache", "PrivateTranscribe", "models", MODEL_FILE)
    );
    expect((await readPastes(electronApp))[0].text.toLowerCase()).toContain("banana");
  });
});
