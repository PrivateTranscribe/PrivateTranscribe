import fs from "node:fs";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";
import { evidenceDir } from "./fixtures/evidence";

/**
 * The first dictation must explain itself when it is slow, and must hand the
 * user a way out when it cannot work at all.
 *
 * Two first-run dead ends, both previously silent behind the overlay's generic
 * processing state:
 *
 *   1. The first dictation after launch pays the whisper model load. On CPU
 *      that runs long enough to read as a hang, and nothing said why. Now a
 *      toast names the model load once the first local transcription has been
 *      processing for a few seconds.
 *   2. "Skip for now" in onboarding leaves local mode selected with no model
 *      on disk. The first dictation then fails with a toast that named
 *      Settings but gave no way to get there. Now the toast carries an
 *      "Open Settings" button routed at the transcription tab.
 *
 * These are also the evidence screenshots for the first-run feedback change.
 */

const FIXTURE_DIR = path.resolve(__dirname, "..", "fixtures", "dictation");
const EVIDENCE_DIR = evidenceDir("dictation-first-run-feedback");
const MIN_SCREENSHOT_BYTES = 1_000;

const RECORD_MS = 8_000;
const TOAST_TIMEOUT_MS = 90_000;

const recordingHalo = (overlay: Page) =>
  overlay.locator('div[aria-hidden="true"][style*="width: 68px"][style*="radial-gradient"]');

async function captureEvidence(page: Page, fileName: string) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const filePath = path.join(EVIDENCE_DIR, fileName);
  await page.screenshot({ path: filePath, fullPage: true });

  const bytes = fs.statSync(filePath).size;
  expect(bytes, `${fileName} is too small to show anything (${bytes} bytes)`).toBeGreaterThan(
    MIN_SCREENSHOT_BYTES
  );
}

async function configureDictation(overlay: Page, whisperModel: string): Promise<void> {
  await overlay.evaluate((model) => {
    localStorage.setItem("useLocalWhisper", "true");
    localStorage.setItem("whisperModel", model);
    localStorage.setItem("localTranscriptionProvider", "whisper");
    localStorage.setItem("useReasoningModel", "false");
    localStorage.setItem("whisperForceCpu", "true");
    localStorage.setItem("autoPaste", "false");
    localStorage.setItem("copyToClipboard", "false");
    localStorage.setItem("enableCorrectionLearning", "false");
    localStorage.setItem("enablePhraseCorrectionLearning", "false");
    localStorage.setItem("actionEngineEnabled", "false");
    localStorage.setItem("audioFeedback", "false");
    localStorage.setItem("successConfirmation", "false");
    localStorage.setItem("customDictionary", "[]");
  }, whisperModel);
  await overlay.evaluate(() =>
    (window as unknown as { electronAPI: any }).electronAPI.setWhisperForceCpu(true)
  );
  await overlay.reload({ waitUntil: "domcontentloaded" });
  await expect(overlay.getByRole("button", { name: "Dictation overlay" })).toBeVisible();
}

/** Start one dictation the way the hotkey does, and stop it after RECORD_MS. */
async function dictate(app: ElectronApplication, overlay: Page): Promise<void> {
  const toggle = () =>
    app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && !w.webContents.getURL().includes("panel=true")
      );
      if (!win) throw new Error("no dictation overlay window to toggle");
      win.webContents.send("toggle-dictation");
    });

  const halo = recordingHalo(overlay);
  await toggle();
  await expect(halo).toHaveCount(1, { timeout: 30_000 });
  await overlay.waitForTimeout(RECORD_MS);
  await toggle();
}

test.describe("cold-start model load feedback", () => {
  test.use({
    fakeAudioCaptureFile: path.join(FIXTURE_DIR, "banana.wav"),
    // The medium model's cold load is reliably longer than the 4s threshold
    // the hint fires at. base can load faster than that on a quick machine,
    // which would make this spec flaky rather than the feature wrong.
    seedRealWhisperModels: ["medium"],
    appEnv: { WHISPER_FORCE_CPU: "true" },
  });

  test("a slow first dictation names the model load", async ({ electronApp, overlayWindow }) => {
    await configureDictation(overlayWindow, "medium");
    await dictate(electronApp, overlayWindow);

    await expect(overlayWindow.getByText("Loading the speech model")).toBeVisible({
      timeout: TOAST_TIMEOUT_MS,
    });
    await captureEvidence(overlayWindow, "dictation-feedback-cold-start.png");
  });
});

test.describe("missing model dead end", () => {
  test.use({
    fakeAudioCaptureFile: path.join(FIXTURE_DIR, "banana.wav"),
    // A home directory with no models at all: the "Skip for now" onboarding
    // state, regardless of what the developer's machine has downloaded.
    useThrowawayHome: true,
    appEnv: { WHISPER_FORCE_CPU: "true" },
  });

  test("dictating with no model on disk offers the way out", async ({
    electronApp,
    overlayWindow,
  }) => {
    await configureDictation(overlayWindow, "base");
    await dictate(electronApp, overlayWindow);

    await expect(overlayWindow.getByText(/not downloaded/)).toBeVisible({
      timeout: TOAST_TIMEOUT_MS,
    });
    await expect(overlayWindow.getByRole("button", { name: "Open Settings" })).toBeVisible();
    await captureEvidence(overlayWindow, "dictation-feedback-model-missing.png");
  });
});
