import fs from "node:fs";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";

/**
 * Agent Mode end to end: the hold key starts an Agent Mode recording, the
 * ramble is decoded by a real whisper model, the rewrite goes out to the
 * Claude Code CLI and comes back, and the paste carries the send-Enter request.
 *
 * The key itself is not pressed: the fixture disables the native listener so
 * a run never binds a machine-global key. The spec sends the same IPC the
 * listener's hold gesture sends, which is where the listener hands over.
 * The paste handler is replaced with one that records what it was asked to
 * paste, because the fixture must never type into whatever window Kristian
 * has in front. The CLI is a stub (claude-print-stub.cjs) for the same reason
 * a live one would spend Kristian's subscription on every run.
 *
 * The ramble is the product spec's sentence, spoken by Windows text to speech
 * into tests/fixtures/dictation/agent-ramble.wav.
 */

const FIXTURE_DIR = path.resolve(__dirname, "..", "fixtures", "dictation");
const EVIDENCE_DIR = path.resolve(__dirname, "..", "..", "docs", "goal-evidence");
const STUB_PATH = path.resolve(__dirname, "fixtures", "claude-print-stub.cjs");
const MIN_SCREENSHOT_BYTES = 1_000;

/** Fixture speech (11.5 s) plus a cold whisper model load, with slack. */
const RECORD_MS = 13_000;

type PasteCall = { text: string; options: Record<string, unknown> | undefined };

async function captureEvidence(page: Page, fileName: string) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const filePath = path.join(EVIDENCE_DIR, fileName);
  await page.screenshot({ path: filePath, fullPage: true });
  const bytes = fs.statSync(filePath).size;
  expect(bytes, `${fileName} is too small to show anything (${bytes} bytes)`).toBeGreaterThan(
    MIN_SCREENSHOT_BYTES
  );
}

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
    localStorage.setItem("enableVariableSnapping", "false");
    localStorage.setItem("actionEngineEnabled", "false");
    localStorage.setItem("audioFeedback", "false");
    localStorage.setItem("successConfirmation", "false");
    localStorage.setItem("customDictionary", "[]");
    localStorage.setItem("preferredLanguage", "en");
  });
  await overlay.evaluate(() =>
    (window as unknown as { electronAPI: any }).electronAPI.setWhisperForceCpu(true)
  );
  await overlay.reload({ waitUntil: "domcontentloaded" });
  await expect(overlay.getByRole("button", { name: "Dictation overlay" })).toBeVisible();
}

/** Replace paste-text with a recorder; the real one would type into the desktop. */
async function recordPastes(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __agentModePastes: PasteCall[] };
    g.__agentModePastes = [];
    ipcMain.removeHandler("paste-text");
    ipcMain.handle(
      "paste-text",
      async (_event, text: string, options?: Record<string, unknown>) => {
        g.__agentModePastes.push({ text, options });
        return { delivered: true, method: "e2e-recorder", enterSent: options?.sendEnter === true };
      }
    );
  });
}

async function readPastes(app: ElectronApplication): Promise<PasteCall[]> {
  return app.evaluate(
    () => (globalThis as unknown as { __agentModePastes: PasteCall[] }).__agentModePastes ?? []
  );
}

function sendToOverlay(app: ElectronApplication, channel: string) {
  return app.evaluate(({ BrowserWindow }, ch) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && !w.webContents.getURL().includes("panel=true")
    );
    if (!win) throw new Error("no dictation overlay window");
    win.webContents.send(ch);
  }, channel);
}

test.describe("Agent Mode", () => {
  test.use({
    fakeAudioCaptureFile: path.join(FIXTURE_DIR, "agent-ramble.wav"),
    seedRealWhisperModels: ["base"],
    appEnv: {
      WHISPER_FORCE_CPU: "true",
      // The rewrite runs for real through the app's spawn path; only the
      // binary on the other end is the stub.
      PRIVATETRANSCRIBE_DIAG_DISABLE_AGENT_REWRITE: "",
      PT_CONVERSE_CLAUDE_BIN: process.execPath,
      PT_CONVERSE_CLAUDE_ARGS: JSON.stringify([STUB_PATH]),
    },
  });

  test("the hold key pastes a cleaned prompt and asks for Enter", async ({
    electronApp,
    overlayWindow,
  }) => {
    await configureDictation(overlayWindow);
    await recordPastes(electronApp);

    // The main process reports the key as not live under the fixture's flag,
    // which is the point: nothing global is bound during a test run.
    const status = await overlayWindow.evaluate(() =>
      (window as unknown as { electronAPI: any }).electronAPI.agentModeHotkeyStatus()
    );
    expect(status).toMatchObject({ hotkey: "RightControl", registered: false });

    await sendToOverlay(electronApp, "start-agent-dictation");
    const badge = overlayWindow.getByText("Agent Mode", { exact: true });
    await expect(badge).toBeVisible({ timeout: 30_000 });
    await captureEvidence(overlayWindow, "agent-mode-overlay-recording.png");

    await overlayWindow.waitForTimeout(RECORD_MS);
    await sendToOverlay(electronApp, "stop-agent-dictation");

    await expect
      .poll(() => readPastes(electronApp).then((p) => p.length), { timeout: 90_000 })
      .toBe(1);
    await expect(badge).toHaveCount(0, { timeout: 15_000 });

    const [paste] = await readPastes(electronApp);
    expect(paste.options).toEqual({ sendEnter: true });
    // The stub's reply, which proves the spawn, the stdin hand-over and the
    // JSON parse all ran; the spoken tail decided Enter, not the reply.
    expect(paste.text).toBe(
      "Fix the crash when the login form is submitted empty. " +
        "It is in `auth/login.ts`, the `validate` function. Fix it and add a test."
    );
  });

  test("a plain dictation still pastes without Enter", async ({ electronApp, overlayWindow }) => {
    await configureDictation(overlayWindow);
    await recordPastes(electronApp);

    await sendToOverlay(electronApp, "toggle-dictation");
    await expect(overlayWindow.getByText("Agent Mode", { exact: true })).toHaveCount(0);
    await overlayWindow.waitForTimeout(RECORD_MS);
    await sendToOverlay(electronApp, "toggle-dictation");

    await expect
      .poll(() => readPastes(electronApp).then((p) => p.length), { timeout: 90_000 })
      .toBe(1);
    const [paste] = await readPastes(electronApp);
    expect(paste.options ?? {}).not.toHaveProperty("sendEnter", true);
    expect(paste.text).toMatch(/\bsend\b/i);
  });

  test("a Starter install at the daily cap is stopped before recording", async ({
    electronApp,
    overlayWindow,
    controlPanel,
  }) => {
    await configureDictation(overlayWindow);
    await recordPastes(electronApp);
    await overlayWindow.evaluate(() => {
      localStorage.setItem("PRO_ENFORCEMENT", "true");
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
        now.getDate()
      ).padStart(2, "0")}`;
      localStorage.setItem(
        "privatetranscribe_agent_mode_usage_v1",
        JSON.stringify({ date: today, usesToday: 20, limit: 20 })
      );
    });
    await overlayWindow.reload({ waitUntil: "domcontentloaded" });
    await expect(overlayWindow.getByRole("button", { name: "Dictation overlay" })).toBeVisible();

    await controlPanel.getByRole("button", { name: "History" }).click();
    await sendToOverlay(electronApp, "start-agent-dictation");

    await expect(overlayWindow.getByText("Agent Mode free uses spent for today")).toBeVisible({
      timeout: 15_000,
    });
    await captureEvidence(overlayWindow, "agent-mode-cap-toast.png");
    await expect(
      controlPanel.getByText("PrivateTranscribe Pro", { exact: false }).first()
    ).toBeVisible({ timeout: 15_000 });

    await overlayWindow.waitForTimeout(2_000);
    expect(await readPastes(electronApp)).toHaveLength(0);
  });
});
