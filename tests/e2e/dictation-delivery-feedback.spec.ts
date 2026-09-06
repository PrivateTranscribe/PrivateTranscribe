import fs from "node:fs";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";

/**
 * A dictation that was not delivered must say so.
 *
 * The delivery chain is paste → clipboard fallback → history, and every link
 * can fail on a real Windows machine (missing fast-paste helper, AV blocking
 * keystroke dispatch, an elevated target window). Until this spec's feature,
 * each failure was silent: the success toast explicitly skipped copy-fallback,
 * safePaste's delivered:false branch called no onError, and the
 * recoverable:false result of deliverDictation was computed and discarded.
 * To the user, all three read as "the hotkey did nothing".
 *
 * Each test drives a real dictation through the fake-capture microphone and a
 * real whisper decode, with the main-process delivery handlers stubbed to fail
 * the way the real ones do — paste-text reports delivered:false exactly as
 * pasteWindows does when the helper is missing, never by throwing. The
 * renderer-side logic under test runs unmodified.
 *
 * These are also the evidence screenshots for the delivery-feedback change.
 */

const FIXTURE_DIR = path.resolve(__dirname, "..", "fixtures", "dictation");
const EVIDENCE_DIR = path.resolve(__dirname, "..", "..", "docs", "qa-0.17.1");
const MIN_SCREENSHOT_BYTES = 1_000;

/** Fixture speech plus a cold whisper model load, with slack. */
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

/**
 * Local whisper with auto-paste on — the delivery chain under test — and the
 * success toast off, because the failure toasts must not depend on it.
 */
async function configureDictation(overlay: Page): Promise<void> {
  await overlay.evaluate(() => {
    localStorage.setItem("useLocalWhisper", "true");
    localStorage.setItem("whisperModel", "base");
    localStorage.setItem("localTranscriptionProvider", "whisper");
    localStorage.setItem("useReasoningModel", "false");
    localStorage.setItem("whisperForceCpu", "true");
    localStorage.setItem("autoPaste", "true");
    localStorage.setItem("copyToClipboard", "false");
    localStorage.setItem("enableCorrectionLearning", "false");
    localStorage.setItem("enablePhraseCorrectionLearning", "false");
    localStorage.setItem("actionEngineEnabled", "false");
    localStorage.setItem("audioFeedback", "false");
    localStorage.setItem("successConfirmation", "false");
    localStorage.setItem("customDictionary", "[]");
  });
  await overlay.evaluate(() =>
    (window as unknown as { electronAPI: any }).electronAPI.setWhisperForceCpu(true)
  );
  await overlay.reload({ waitUntil: "domcontentloaded" });
  await expect(overlay.getByRole("button", { name: "Dictation overlay" })).toBeVisible();
}

type DeliveryFailure =
  | "paste"
  | "paste-unreadable"
  | "paste-stale"
  | "paste-confirmed"
  | "paste-and-clipboard"
  | "everything";

/**
 * Re-register the main-process delivery handlers to fail like their real
 * failure modes: paste-text resolves delivered:false (the missing-helper
 * shape from pasteWindows), the others reject the invoke.
 */
async function breakDelivery(app: ElectronApplication, failure: DeliveryFailure): Promise<void> {
  await app.evaluate(({ ipcMain }, mode) => {
    ipcMain.removeHandler("paste-text");
    ipcMain.handle("paste-text", async () => ({
      delivered: mode === "paste-confirmed",
      // "none" is the helper saying it could not read the target at all, which
      // is not the same as the text failing to arrive.
      evidence: mode === "paste-unreadable" ? "none" : "absent",
      dispatched: ["paste-unreadable", "paste-stale", "paste-confirmed"].includes(mode),
      fallback: "clipboard",
    }));

    // Never overwrite the developer's real clipboard during delivery tests.
    ipcMain.removeHandler("write-clipboard");
    ipcMain.handle("write-clipboard", async () => true);
    if (mode === "paste-and-clipboard" || mode === "everything") {
      ipcMain.removeHandler("write-clipboard");
      ipcMain.handle("write-clipboard", async () => {
        throw new Error("e2e: clipboard unavailable");
      });
    }

    if (mode === "everything") {
      ipcMain.removeHandler("db-save-transcription");
      ipcMain.handle("db-save-transcription", async () => {
        throw new Error("e2e: database unavailable");
      });
    }
  }, failure);
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

  const halo = recordingHalo(overlay);
  await toggle();
  await expect(halo).toHaveCount(1, { timeout: 30_000 });
  await overlay.waitForTimeout(RECORD_MS);
  await toggle();
  await expect(halo).toHaveCount(0, { timeout: 60_000 });
}

test.describe("dictation delivery feedback", () => {
  test.use({
    fakeAudioCaptureFile: path.join(FIXTURE_DIR, "banana.wav"),
    seedRealWhisperModels: ["base"],
    appEnv: { WHISPER_FORCE_CPU: "true" },
  });

  test("a paste that fell back to the clipboard says so", async ({
    electronApp,
    overlayWindow,
  }) => {
    await configureDictation(overlayWindow);
    await breakDelivery(electronApp, "paste");
    await dictate(electronApp, overlayWindow);

    await expect(overlayWindow.getByText("Text copied", { exact: true })).toBeVisible({
      timeout: TOAST_TIMEOUT_MS,
    });
    await expect(overlayWindow.getByText(/press Ctrl\+V/)).toBeVisible();
    await captureEvidence(overlayWindow, "after-paste-unavailable.png");
  });

  // Elevated windows, password fields and fullscreen games give the helper
  // nothing to read. Warning there put a false "it did not paste" in front of
  // people whose paste had worked, so an unreadable target now says nothing and
  // leaves the text on the clipboard.
  for (const mode of ["paste-unreadable", "paste-stale", "paste-confirmed"] as const) {
    test(`a ${mode} result stays quiet`, async ({ electronApp, overlayWindow }) => {
      await configureDictation(overlayWindow);
      await breakDelivery(electronApp, mode);
      await dictate(electronApp, overlayWindow);

      // Delivery persists to history before it pastes, so a saved transcript means
      // the toast has already had its chance. Waiting out the full toast timeout
      // instead would spend the whole test budget.
      await expect
        .poll(
          () =>
            overlayWindow.evaluate(async () => {
              const rows = await (
                window as unknown as { electronAPI: any }
              ).electronAPI.getTranscriptions(1);
              return Array.isArray(rows) ? rows.length : 0;
            }),
          { timeout: 60_000 }
        )
        .toBeGreaterThan(0);
      await overlayWindow.waitForTimeout(2_000);

      await expect(overlayWindow.getByText("Text copied", { exact: true })).toHaveCount(0);
      await expect(overlayWindow.getByText("Transcription complete", { exact: true })).toHaveCount(
        0
      );
      await expect(overlayWindow.getByText("Saved to History only")).toHaveCount(0);
      await expect(overlayWindow.getByText("Dictation could not be delivered")).toHaveCount(0);
      await captureEvidence(overlayWindow, `after-${mode}-quiet.png`);
    });
  }

  test("paste and clipboard both failing points at History", async ({
    electronApp,
    overlayWindow,
  }) => {
    await configureDictation(overlayWindow);
    await breakDelivery(electronApp, "paste-and-clipboard");
    await dictate(electronApp, overlayWindow);

    await expect(overlayWindow.getByText("Saved to History only")).toBeVisible({
      timeout: TOAST_TIMEOUT_MS,
    });
    await captureEvidence(overlayWindow, "dictation-feedback-history-only.png");
  });

  test("losing every delivery route shows the words themselves", async ({
    electronApp,
    overlayWindow,
  }) => {
    await configureDictation(overlayWindow);
    await breakDelivery(electronApp, "everything");
    await dictate(electronApp, overlayWindow);

    await expect(overlayWindow.getByText("Dictation could not be delivered")).toBeVisible({
      timeout: TOAST_TIMEOUT_MS,
    });
    // The toast carries the transcript - the only surviving copy of the words.
    await expect(overlayWindow.getByText(/banana/i)).toBeVisible();
    await captureEvidence(overlayWindow, "dictation-feedback-lost.png");
  });
});
