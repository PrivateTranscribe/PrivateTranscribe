import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";
import { evidenceDir } from "./fixtures/evidence";
import { enableBetaFeatures, enableBetaFeaturesInOverlay } from "./fixtures/tester-access";

/**
 * With AI cleanup on, a failing provider pasted the raw text with no word
 * why, so the feature looked broken. Cleanup also counted as available when
 * any provider had a key, so a missing key for the selected provider failed
 * the same silent way. Now the raw text is still kept and the overlay says
 * why, once per kind of failure.
 *
 * Real dictation through the fake microphone and local Whisper. The cloud
 * reply is stubbed in the overlay, so no request leaves the machine; nothing
 * is pasted or copied.
 */

const WAV = path.resolve(__dirname, "..", "fixtures", "dictation", "banana.wav");
const TRUTH = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "..", "fixtures", "dictation", "banana.truth.json"),
    "utf8"
  )
) as { totalSec: number };
const BASE_MODEL = path.join(
  os.homedir(),
  ".cache",
  "PrivateTranscribe",
  "whisper-models",
  "ggml-base.bin"
);
const RECORD_MS = Math.ceil(TRUTH.totalSec * 1000) * 2;
const HALO = 'div[aria-hidden="true"][style*="width: 68px"][style*="radial-gradient"]';

test.use({ fakeAudioCaptureFile: WAV, appEnv: { WHISPER_FORCE_CPU: "true" } });

async function configure(page: Page, cleanup: { provider: string; model: string }) {
  await page.evaluate((c) => {
    localStorage.setItem("useLocalWhisper", "true");
    localStorage.setItem("whisperModel", "base");
    localStorage.setItem("localTranscriptionProvider", "whisper");
    localStorage.setItem("whisperForceCpu", "true");
    localStorage.setItem("autoPaste", "false");
    localStorage.setItem("copyToClipboard", "false");
    localStorage.setItem("enableCorrectionLearning", "false");
    localStorage.setItem("actionEngineEnabled", "false");
    localStorage.setItem("audioFeedback", "false");
    localStorage.setItem("successConfirmation", "false");
    localStorage.setItem("useReasoningModel", "true");
    localStorage.setItem("reasoningProvider", c.provider);
    localStorage.setItem("reasoningModel", c.model);
  }, cleanup);
}

async function dictate(app: ElectronApplication, overlay: Page) {
  const toggle = () =>
    app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && !w.webContents.getURL().includes("panel=true")
      );
      win!.webContents.send("toggle-dictation");
    });
  const halo = overlay.locator(HALO);
  await toggle();
  await expect(halo).toHaveCount(1, { timeout: 30_000 });
  await overlay.waitForTimeout(RECORD_MS);
  await toggle();
  await expect(halo).toHaveCount(0, { timeout: 60_000 });
}

async function latestText(page: Page): Promise<string | null> {
  const rows = (await page.evaluate(() =>
    (window as any).electronAPI.getTranscriptions(10)
  )) as Array<{ id: number; text: string }>;
  return rows.sort((a, b) => b.id - a.id)[0]?.text ?? null;
}

test.beforeEach(() => {
  expect(fs.existsSync(BASE_MODEL), `ggml-base.bin is missing at ${BASE_MODEL}`).toBe(true);
});

test("a refused key keeps the raw text and says why", async ({
  electronApp,
  overlayWindow,
  controlPanel,
}) => {
  test.setTimeout(240_000);
  const shots = evidenceDir("ai-cleanup-failure-notice");
  fs.mkdirSync(shots, { recursive: true });

  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("get-openai-key");
    ipcMain.handle("get-openai-key", () => "e2e-wrong-key");
  });
  await enableBetaFeatures(controlPanel);
  await configure(controlPanel, { provider: "openai", model: "gpt-5.6-luna" });
  await enableBetaFeaturesInOverlay(overlayWindow);
  await overlayWindow.evaluate(() => {
    (window as any).__cleanupRequests = 0;
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (String(input).startsWith("https://api.openai.com/")) {
        (window as any).__cleanupRequests += 1;
        return new Response(JSON.stringify({ error: { message: "Incorrect API key provided" } }), {
          status: 401,
        });
      }
      return original(input, init);
    };
  });

  await dictate(electronApp, overlayWindow);

  await expect(overlayWindow.getByText("AI cleanup skipped")).toBeVisible({
    timeout: 120_000,
  });
  await expect(
    overlayWindow.getByText("OpenAI refused the API key. Check it in AI Enhancement.")
  ).toBeVisible();
  expect(await overlayWindow.evaluate(() => (window as any).__cleanupRequests)).toBeGreaterThan(0);
  await expect.poll(() => latestText(controlPanel), { timeout: 30_000 }).toMatch(/banana/i);
  await overlayWindow.screenshot({ path: path.join(shots, "refused-key.png") });
});

test("cleanup on without the selected provider's key says so", async ({
  electronApp,
  overlayWindow,
  controlPanel,
}) => {
  test.setTimeout(240_000);
  const shots = evidenceDir("ai-cleanup-failure-notice");
  fs.mkdirSync(shots, { recursive: true });

  // A key for another provider. It used to make cleanup count as available.
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("get-openai-key");
    ipcMain.handle("get-openai-key", () => "e2e-other-provider-key");
  });
  await enableBetaFeatures(controlPanel);
  await configure(controlPanel, { provider: "anthropic", model: "claude-sonnet-5" });
  await enableBetaFeaturesInOverlay(overlayWindow);

  await dictate(electronApp, overlayWindow);

  await expect(
    overlayWindow.getByText("Anthropic has no API key. Add one in AI Enhancement.")
  ).toBeVisible({ timeout: 120_000 });
  await expect.poll(() => latestText(controlPanel), { timeout: 30_000 }).toMatch(/banana/i);
  await overlayWindow.screenshot({ path: path.join(shots, "no-key.png") });
});
