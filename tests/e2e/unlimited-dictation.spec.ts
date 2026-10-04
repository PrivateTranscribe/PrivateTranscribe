import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";

test.use({ experimentalFeatures: true });

/**
 * Dictation and Agent mode have no daily cap.
 *
 * Installs from before the free release still carry the old daily records,
 * spent: 5,000 words against a 1,000 word cap, and 20 of 20 coding prompts.
 * Nothing may read them. The recording starts, transcribes and pastes, and no
 * cap toast appears. The paste handler records instead of typing into whatever
 * window is in front.
 */

const FIXTURE_DIR = path.resolve(__dirname, "..", "fixtures", "dictation");

/** Fixture speech plus a cold whisper model load, with slack. */
const RECORD_MS = 8_000;

type PasteCall = { text: string; options: Record<string, unknown> | undefined };

const recordingHalo = (overlay: Page) =>
  overlay.locator('div[aria-hidden="true"][style*="width: 68px"][style*="radial-gradient"]');

async function recordPastes(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __unlimitedPastes: PasteCall[] };
    g.__unlimitedPastes = [];
    ipcMain.removeHandler("paste-text");
    ipcMain.handle(
      "paste-text",
      async (_event, text: string, options?: Record<string, unknown>) => {
        g.__unlimitedPastes.push({ text, options });
        return { delivered: true, method: "e2e-recorder" };
      }
    );
    ipcMain.removeHandler("write-clipboard");
    ipcMain.handle("write-clipboard", async () => true);
  });
}

async function readPastes(app: ElectronApplication): Promise<PasteCall[]> {
  return app.evaluate(
    () => (globalThis as unknown as { __unlimitedPastes: PasteCall[] }).__unlimitedPastes ?? []
  );
}

function toggleDictation(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && !w.webContents.getURL().includes("panel=true")
    );
    if (!win) throw new Error("no dictation overlay window to toggle");
    win.webContents.send("toggle-dictation");
  });
}

/** Local whisper dictation, plus both spent daily records in their old shape. */
async function configureSpentInstall(overlay: Page, agentMode: boolean): Promise<void> {
  await overlay.evaluate((agentModeOn) => {
    localStorage.setItem("useLocalWhisper", "true");
    localStorage.setItem("whisperModel", "base");
    localStorage.setItem("localTranscriptionProvider", "whisper");
    localStorage.setItem("useReasoningModel", "false");
    localStorage.setItem("whisperForceCpu", "true");
    localStorage.setItem("autoPaste", "true");
    localStorage.setItem("copyToClipboard", "false");
    localStorage.setItem("enableCorrectionLearning", "false");
    localStorage.setItem("actionEngineEnabled", "false");
    localStorage.setItem("agentModeDictationEnabled", String(agentModeOn));
    // Pasted as spoken, so the run never waits on a Claude Code rewrite.
    localStorage.setItem("agentModeRewrite", "false");
    localStorage.setItem("audioFeedback", "false");
    localStorage.setItem("successConfirmation", "false");
    localStorage.setItem("customDictionary", "[]");
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate()
    ).padStart(2, "0")}`;
    localStorage.setItem(
      "privatetranscribe_starter_usage_v1",
      JSON.stringify({ date: today, wordsUsed: 5000, limit: 1000 })
    );
    localStorage.setItem(
      "privatetranscribe_agent_mode_usage_v1",
      JSON.stringify({ date: today, usesToday: 20, limit: 20 })
    );
  }, agentMode);
  await overlay.evaluate(() =>
    (window as unknown as { electronAPI: any }).electronAPI.setWhisperForceCpu(true)
  );
  await overlay.reload({ waitUntil: "domcontentloaded" });
  await expect(overlay.getByRole("button", { name: "Dictation overlay" })).toBeVisible();
}

async function expectNoCapToast(overlay: Page): Promise<void> {
  await expect(overlay.getByText(/limit reached/i)).toHaveCount(0);
  await expect(overlay.getByText(/used up/i)).toHaveCount(0);
}

test.describe("Unlimited dictation", () => {
  test.use({
    fakeAudioCaptureFile: path.join(FIXTURE_DIR, "banana.wav"),
    seedRealWhisperModels: ["base"],
    appEnv: { WHISPER_FORCE_CPU: "true" },
  });

  test("an install past the old 1,000 words still records and pastes", async ({
    electronApp,
    overlayWindow,
  }) => {
    await configureSpentInstall(overlayWindow, false);
    await recordPastes(electronApp);

    const halo = recordingHalo(overlayWindow);
    await toggleDictation(electronApp);
    await expect(halo).toHaveCount(1, { timeout: 30_000 });
    await overlayWindow.waitForTimeout(RECORD_MS);
    await toggleDictation(electronApp);

    await expect
      .poll(() => readPastes(electronApp).then((p) => p.length), { timeout: 90_000 })
      .toBe(1);
    const [paste] = await readPastes(electronApp);
    expect(paste.text).toMatch(/banana/i);
    await expectNoCapToast(overlayWindow);
  });

  test("an install past the old 20 coding prompts still runs Agent mode", async ({
    electronApp,
    overlayWindow,
  }) => {
    await configureSpentInstall(overlayWindow, true);
    await recordPastes(electronApp);

    await toggleDictation(electronApp);
    const badge = overlayWindow.getByText("Coding prompt", { exact: true });
    await expect(badge).toBeVisible({ timeout: 30_000 });
    await overlayWindow.waitForTimeout(RECORD_MS);
    await toggleDictation(electronApp);

    await expect
      .poll(() => readPastes(electronApp).then((p) => p.length), { timeout: 90_000 })
      .toBe(1);
    const [paste] = await readPastes(electronApp);
    expect(paste.text).toMatch(/banana/i);
    await expectNoCapToast(overlayWindow);
  });
});
