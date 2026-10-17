import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";

/**
 * A dictation past one minute is transcribed while the speaker is still
 * talking, so stopping leaves only the last segment to wait for.
 *
 * Real recorder, fake hardware: Chromium plays the committed interview into
 * getUserMedia, and MediaRecorder, segment rotation, the pause detector,
 * whisper.cpp and the history write all run as they do for a user. Nothing
 * is pasted or copied.
 *
 * What it proves, from whisper-server's own request log:
 *   - the first segment reaches whisper-server before stop, between the 60 s
 *     promotion and the 90 s hard cap, so the cut waited for a pause rather
 *     than landing on the threshold;
 *   - the finished dictation is saved whole, with the first segment and the
 *     tail joined.
 */

const INTERVIEW_WAV = path.resolve(__dirname, "..", "fixtures", "multispeaker", "interview.wav");
const BASE_MODEL = path.join(
  os.homedir(),
  ".cache",
  "PrivateTranscribe",
  "whisper-models",
  "ggml-base.bin"
);
const RECORD_MS = 80_000;

test.use({ fakeAudioCaptureFile: INTERVIEW_WAV, appEnv: { WHISPER_FORCE_CPU: "true" } });

type InferenceRequest = { longSessionChunk?: boolean; durationSeconds?: number; at: number };

const api = (page: Page) => page.evaluate.bind(page) as Page["evaluate"];

const recordingHalo = (overlay: Page) =>
  overlay.locator('div[aria-hidden="true"][style*="width: 68px"][style*="radial-gradient"]');

async function requests(page: Page): Promise<InferenceRequest[]> {
  const diagnostics = await api(page)(() =>
    (window as unknown as { electronAPI: any }).electronAPI.getAudioDiagnostics()
  );
  return diagnostics?.recentInferenceRequests ?? [];
}

async function history(page: Page): Promise<string[]> {
  const rows = (await api(page)(() =>
    (window as unknown as { electronAPI: any }).electronAPI.getTranscriptions(10)
  )) as { text: string }[];
  return rows.map((row) => row.text);
}

async function toggle(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && !w.webContents.getURL().includes("panel=true")
    );
    if (!win) throw new Error("no dictation overlay window to toggle");
    win.webContents.send("toggle-dictation");
  });
}

test.describe("Live dictation", () => {
  test("transcribes the first minute while recording, cut at a pause", async ({
    electronApp,
    overlayWindow,
    controlPanel,
  }) => {
    test.setTimeout(240_000);
    expect(
      fs.existsSync(BASE_MODEL),
      `ggml-base.bin is not installed at ${BASE_MODEL} — download it before running this spec`
    ).toBe(true);

    await api(controlPanel)(() => {
      localStorage.setItem("useLocalWhisper", "true");
      localStorage.setItem("whisperModel", "base");
      localStorage.setItem("localTranscriptionProvider", "whisper");
      localStorage.setItem("preferredLanguage", "en");
      localStorage.setItem("useReasoningModel", "false");
      localStorage.setItem("whisperForceCpu", "true");
      localStorage.setItem("autoPaste", "false");
      localStorage.setItem("copyToClipboard", "false");
      localStorage.setItem("enableCorrectionLearning", "false");
      localStorage.setItem("enablePhraseCorrectionLearning", "false");
      localStorage.setItem("actionEngineEnabled", "false");
      localStorage.setItem("audioFeedback", "false");
      localStorage.setItem("successConfirmation", "false");
    });
    await api(controlPanel)(() =>
      (window as unknown as { electronAPI: any }).electronAPI.setWhisperForceCpu(true)
    );

    const before = (await requests(controlPanel)).length;
    const halo = recordingHalo(overlayWindow);
    await toggle(electronApp);
    await expect(halo).toHaveCount(1, { timeout: 30_000 });
    const startedAt = Date.now();

    await overlayWindow.waitForTimeout(RECORD_MS);
    const live = (await requests(controlPanel)).slice(before).filter((r) => r.longSessionChunk);
    const stoppedAt = Date.now();
    await toggle(electronApp);
    await expect(halo).toHaveCount(0, { timeout: 60_000 });

    // The first segment went out while recording, after a pause past 60 s.
    expect(live.length, "no segment reached whisper-server before stop").toBeGreaterThan(0);
    const firstSentAfter = (live[0].at - startedAt) / 1000;
    console.log(
      `first segment sent ${firstSentAfter.toFixed(1)} s into the recording, ` +
        `${live[0].durationSeconds?.toFixed(1)} s of audio after cleanup; stopped at ${(
          (stoppedAt - startedAt) /
          1000
        ).toFixed(1)} s`
    );
    expect(firstSentAfter).toBeGreaterThanOrEqual(60);
    expect(firstSentAfter).toBeLessThan(95);

    await expect
      .poll(async () => (await history(controlPanel)).length, { timeout: 120_000 })
      .toBe(1);
    const [text] = await history(controlPanel);
    console.log(`transcript: ${text}`);
    // 80 s of the interview is about 200 words. The fake microphone loops the
    // file from wherever it was when the stream opened, so count rather than
    // look for a phrase.
    expect(text.split(/\s+/).length).toBeGreaterThan(120);

    // Stop left only the tail to transcribe.
    const all = (await requests(controlPanel)).slice(before).filter((r) => r.longSessionChunk);
    expect(all.length).toBeGreaterThanOrEqual(2);
  });
});
