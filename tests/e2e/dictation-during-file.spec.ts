import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";
import { evidenceDir } from "./fixtures/evidence";

/**
 * A file with English speaker labels runs on the speaker model
 * (small-en-tdrz). A dictation on another model used to restart local Whisper
 * under it, and the file run died partway through. Now the dictation is
 * refused with a notice and the file finishes.
 *
 * Real file, real dictation through the fake microphone, real CPU decode.
 * Nothing is pasted or copied.
 */

const EMPTY_DIARIZATION_DIR = path.join(os.tmpdir(), "pt-e2e-empty-diarization-models");
const INTERVIEW_WAV = path.resolve(__dirname, "..", "fixtures", "multispeaker", "interview.wav");
const BANANA_WAV = path.resolve(__dirname, "..", "fixtures", "dictation", "banana.wav");
const HALO = 'div[aria-hidden="true"][style*="width: 68px"][style*="radial-gradient"]';

/**
 * The 96 s interview decodes in about 10 s on a fast CPU, less time than a
 * dictation takes. Five copies in a row give a run of about a minute.
 */
function longInterview(): string {
  const wav = fs.readFileSync(INTERVIEW_WAV);
  // Canonical 44-byte PCM header: "data" chunk size at byte 40.
  expect(wav.toString("ascii", 36, 40)).toBe("data");
  const pcm = wav.subarray(44, 44 + wav.readUInt32LE(40));
  const copies = 5;
  const out = Buffer.concat([wav.subarray(0, 44), ...Array(copies).fill(pcm)]);
  out.writeUInt32LE(pcm.length * copies, 40);
  out.writeUInt32LE(out.length - 8, 4);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pt-e2e-long-file-")), "long.wav");
  fs.writeFileSync(file, out);
  return file;
}

test.use({
  appEnv: {
    WHISPER_FORCE_CPU: "true",
    PRIVATETRANSCRIBE_DIARIZATION_MODELS_DIR: EMPTY_DIARIZATION_DIR,
  },
  useThrowawayHome: true,
  seedRealWhisperModels: ["base", "small-en-tdrz"],
  fakeAudioCaptureFile: BANANA_WAV,
});

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
  await overlay.waitForTimeout(4000);
  await toggle();
  await expect(halo).toHaveCount(0, { timeout: 60_000 });
}

test("a dictation on another model leaves a running file alone and says why", async ({
  electronApp,
  overlayWindow,
  controlPanel,
}) => {
  test.setTimeout(420_000);
  const shots = evidenceDir("dictation-during-file");
  fs.mkdirSync(shots, { recursive: true });

  await controlPanel.evaluate(() => {
    localStorage.setItem("useLocalWhisper", "true");
    localStorage.setItem("localTranscriptionProvider", "whisper");
    localStorage.setItem("whisperModel", "base");
    localStorage.setItem("whisperForceCpu", "true");
    localStorage.setItem("useReasoningModel", "false");
    localStorage.setItem("autoPaste", "false");
    localStorage.setItem("copyToClipboard", "false");
    localStorage.setItem("enableCorrectionLearning", "false");
    localStorage.setItem("audioFeedback", "false");
    localStorage.setItem("fileTranscriptionLanguage", "en");
    localStorage.setItem("fileTranscriptionSpeakerDetection", "true");
    localStorage.setItem("fileTranscriptionSpeakerDetectionMode", "tiny-diarize-en");
  });
  await controlPanel.reload({ waitUntil: "domcontentloaded" });
  await overlayWindow.reload({ waitUntil: "domcontentloaded" });
  await controlPanel.evaluate(() => (window as any).electronAPI.setWhisperForceCpu(true));
  await controlPanel.getByRole("button", { name: "Transcribe File", exact: true }).click();
  const longFile = longInterview();
  await controlPanel.locator('input[type="file"]').setInputFiles(longFile);
  await expect(controlPanel.getByRole("heading", { name: /Transcribing/ })).toBeVisible({
    timeout: 60_000,
  });
  // Let the file run load the speaker model before the dictation asks for Base.
  await controlPanel.waitForTimeout(4000);

  await dictate(electronApp, overlayWindow);

  await expect(overlayWindow.getByText("A file is being transcribed")).toBeVisible({
    timeout: 60_000,
  });
  await overlayWindow.screenshot({ path: path.join(shots, "overlay-notice.png") });

  await expect(controlPanel.getByRole("heading", { name: "Done" })).toBeVisible({
    timeout: 300_000,
  });
  await expect(controlPanel.locator("textarea[readonly]")).not.toBeEmpty();
  await expect(controlPanel.getByRole("heading", { name: "Transcription failed" })).toHaveCount(0);
  await controlPanel.screenshot({ path: path.join(shots, "file-done.png") });

  // The refused dictation left nothing in the history.
  const rows = (await controlPanel.evaluate(() =>
    (window as any).electronAPI.getTranscriptions(10)
  )) as Array<{ text: string }>;
  expect(rows.some((r) => /banana/i.test(r.text))).toBe(false);
  fs.rmSync(path.dirname(longFile), { recursive: true, force: true });
});
