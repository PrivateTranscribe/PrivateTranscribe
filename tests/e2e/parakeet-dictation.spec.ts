import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";

/**
 * Dictation on NVIDIA Parakeet, through the real recorder, IPC and engine.
 *
 * The model cache lives under the home directory, not userData, so the
 * throwaway profile still sees this machine's real Parakeet and Whisper models.
 * banana.wav says "I put the banana in my backpack yesterday." and ends in
 * 2.5 s of silence, so the looping fake microphone never cuts a word in half
 * at the point the recording stops.
 */

const FIXTURE_DIR = path.resolve(__dirname, "..", "fixtures", "dictation");
const MODEL_CACHE = path.join(os.homedir(), ".cache", "PrivateTranscribe");
const PARAKEET_MODEL = "parakeet-tdt-0.6b-v3";
const PARAKEET_DIR = path.join(MODEL_CACHE, "parakeet-models", PARAKEET_MODEL);
const WHISPER_BASE = path.join(MODEL_CACHE, "whisper-models", "ggml-base.bin");

/** Longer than the 6 s fixture, so the whole sentence is in the recording. */
const RECORD_MS = 8000;

test.use({
  fakeAudioCaptureFile: path.join(FIXTURE_DIR, "banana.wav"),
  appEnv: { WHISPER_FORCE_CPU: "true", PT_LOG_LEVEL: "debug" },
});

type HistoryRow = { id: number; text: string };

function readAppLog(userDataDir: string): string {
  const logsDir = path.join(userDataDir, "logs");
  if (!fs.existsSync(logsDir)) return "";
  return fs
    .readdirSync(logsDir)
    .filter((name) => name.endsWith(".log"))
    .map((name) => fs.readFileSync(path.join(logsDir, name), "utf8"))
    .join("\n");
}

async function readHistory(page: Page): Promise<HistoryRow[]> {
  return (await page.evaluate(() =>
    (window as any).electronAPI.getTranscriptions(10)
  )) as HistoryRow[];
}

/** Parakeet dictation, with nothing reaching the clipboard or the desktop. */
async function configureParakeet(controlPanel: Page, overlayWindow: Page): Promise<void> {
  await controlPanel.evaluate(async (parakeetModel) => {
    const settings: Record<string, string> = {
      useLocalWhisper: "true",
      localTranscriptionProvider: "nvidia",
      parakeetModel,
      // What the Whisper retry uses; base is the model this machine is known to have.
      whisperModel: "base",
      whisperForceCpu: "true",
      preferredLanguage: "en",
      allowOpenAIFallback: "false",
      useReasoningModel: "false",
      autoPaste: "false",
      copyToClipboard: "false",
      audioFeedback: "false",
      successConfirmation: "false",
      pauseMediaOnRecord: "false",
      musicDuckingMode: "off",
      actionEngineEnabled: "false",
      enableCorrectionLearning: "false",
      customDictionary: "[]",
    };
    for (const [key, value] of Object.entries(settings)) localStorage.setItem(key, value);
    await (window as any).electronAPI.setWhisperForceCpu(true);
  }, PARAKEET_MODEL);
  await overlayWindow.reload({ waitUntil: "load" });
  expect(
    await overlayWindow.evaluate(() => localStorage.getItem("localTranscriptionProvider"))
  ).toBe("nvidia");
}

/** One dictation, driven the way the hotkey drives it. */
async function dictate(app: ElectronApplication, overlay: Page): Promise<void> {
  const toggle = () =>
    app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && !w.webContents.getURL().includes("panel=true")
      );
      if (!win) throw new Error("no dictation overlay window to toggle");
      win.webContents.send("toggle-dictation");
    });
  const halo = overlay.locator(
    'div[aria-hidden="true"][style*="width: 68px"][style*="radial-gradient"]'
  );

  await toggle();
  await expect(halo).toHaveCount(1, { timeout: 30_000 });
  await overlay.waitForTimeout(RECORD_MS);
  await toggle();
  await expect(halo).toHaveCount(0, { timeout: 60_000 });
}

async function waitForOneRow(controlPanel: Page): Promise<HistoryRow> {
  await expect
    .poll(async () => (await readHistory(controlPanel)).length, { timeout: 90_000 })
    .toBe(1);
  return (await readHistory(controlPanel))[0];
}

test.beforeEach(() => {
  expect(
    fs.existsSync(path.join(PARAKEET_DIR, "encoder.int8.onnx")),
    `Parakeet is not installed at ${PARAKEET_DIR}; download it before running this spec`
  ).toBe(true);
  expect(
    fs.existsSync(WHISPER_BASE),
    `ggml-base.bin is not installed at ${WHISPER_BASE}; download it before running this spec`
  ).toBe(true);
});

test("dictates English on Parakeet", async ({
  electronApp,
  controlPanel,
  overlayWindow,
  userDataDir,
}) => {
  test.setTimeout(180_000);
  await configureParakeet(controlPanel, overlayWindow);
  expect(await readHistory(controlPanel)).toHaveLength(0);

  await dictate(electronApp, overlayWindow);
  const row = await waitForOneRow(controlPanel);
  console.log(`[parakeet] transcript: ${row.text}`);

  const text = row.text.toLowerCase();
  expect(text).toContain("banana");
  expect(text).toContain("backpack");

  const log = readAppLog(userDataDir);
  expect(log).toContain("transcribe-local-parakeet called");
  expect(log).toContain("Parakeet transcription complete");
  expect(log).not.toContain("retrying the same audio with local Whisper");
});

test("retries a crashed Parakeet on local Whisper and records Whisper's text", async ({
  electronApp,
  controlPanel,
  overlayWindow,
  userDataDir,
}) => {
  test.setTimeout(180_000);
  await configureParakeet(controlPanel, overlayWindow);

  // What the handler returns when the engine's utility process dies mid-decode.
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("transcribe-local-parakeet");
    ipcMain.handle("transcribe-local-parakeet", async () => ({
      success: false,
      error: "parakeet-host-exited",
      message: "Parakeet engine exited with code 1",
    }));
  });

  await dictate(electronApp, overlayWindow);
  const row = await waitForOneRow(controlPanel);
  console.log(`[whisper retry] transcript: ${row.text}`);

  expect(row.text.toLowerCase()).toContain("backpack");

  const log = readAppLog(userDataDir);
  expect(log).toContain("retrying the same audio with local Whisper");
  expect(log).toContain("parakeet-host-exited");
  expect(log).toContain("transcribe-local-whisper");
});
