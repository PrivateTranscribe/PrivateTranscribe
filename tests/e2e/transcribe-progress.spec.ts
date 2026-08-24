import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";

/**
 * What a running transcription tells the user — audit F6.
 *
 * Files below the 20-minute chunking threshold are decoded as ONE /inference
 * request, and whisper-server answers a request only when it has finished it.
 * The page nonetheless rendered a progress bar whenever percentage > 0, so on
 * every ordinary file the bar appeared for a single frame at 100% at the very
 * end, and the run itself showed nothing but a spinner.
 *
 * The fix is not a smoother fake. There is no percentage to report on a
 * single-pass run, so the page reports what is known instead: how long the run
 * has taken, and how much audio it covers — and it says why there is no
 * percentage. The bar is kept for chunked runs, where one finished chunk is one
 * measured step.
 *
 * Real audio, real CPU decode, own port, own model. The input is built in the
 * OS temp directory by repeating the committed fixture: ~9.6 minutes, which is
 * comfortably inside the single-request path and long enough to observe.
 */
test.use({ appEnv: { WHISPER_FORCE_CPU: "true" } });

const INTERVIEW_WAV = path.resolve(__dirname, "..", "fixtures", "multispeaker", "interview.wav");
const BASE_MODEL = path.join(
  os.homedir(),
  ".cache",
  "PrivateTranscribe",
  "whisper-models",
  "ggml-base.bin"
);
const GOAL_EVIDENCE_DIR = path.resolve(__dirname, "..", "..", "docs", "goal-evidence");

/** Offset and length of a RIFF WAV's `data` chunk. */
function findDataChunk(wav: Buffer): { offset: number; size: number } {
  let cursor = 12;
  while (cursor + 8 <= wav.length) {
    const id = wav.toString("ascii", cursor, cursor + 4);
    const size = wav.readUInt32LE(cursor + 4);
    if (id === "data") return { offset: cursor + 8, size: Math.min(size, wav.length - cursor - 8) };
    cursor += 8 + size + (size % 2);
  }
  throw new Error("No data chunk in the fixture WAV");
}

/**
 * Repeat the fixture's PCM `times` over, as a fresh WAV in the temp directory.
 * The committed fixture is frozen — this only reads it.
 */
function buildLongWav(times: number): string {
  const source = fs.readFileSync(INTERVIEW_WAV);
  const { offset, size } = findDataChunk(source);
  const pcm = Buffer.concat(Array.from({ length: times }, () => source.subarray(offset, offset + size)));

  const header = Buffer.from(source.subarray(0, offset));
  header.writeUInt32LE(offset - 8 + pcm.length, 4);
  header.writeUInt32LE(pcm.length, offset - 4);

  const target = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "pt-e2e-progress-")),
    "long-interview.wav"
  );
  fs.writeFileSync(target, Buffer.concat([header, pcm]));
  return target;
}

/** Pin the run to the CPU engine and wait for the pin to land (see the cancel spec). */
async function prepareForLocalTranscription(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem("useLocalWhisper", "true");
    localStorage.setItem("whisperModel", "base");
    localStorage.setItem("fileTranscriptionSpeakerDetection", "false");
    localStorage.setItem("fileTranscriptionLanguage", "en");
    localStorage.setItem("whisperForceCpu", "true");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.evaluate(() =>
    (window as unknown as { electronAPI: any }).electronAPI.setWhisperForceCpu(true)
  );
}

test.describe("Transcribe page progress", () => {
  test("a single-pass run reports elapsed time and audio length, not a percentage", async ({
    controlPanel,
  }) => {
    expect(
      fs.existsSync(BASE_MODEL),
      `ggml-base.bin is not installed at ${BASE_MODEL} — download it before running this spec`
    ).toBe(true);

    const longWav = buildLongWav(6); // 6 × 96.2s ≈ 9m 37s, one /inference request
    fs.mkdirSync(GOAL_EVIDENCE_DIR, { recursive: true });

    try {
      await prepareForLocalTranscription(controlPanel);
      await controlPanel.getByRole("button", { name: "Transcribe File", exact: true }).click();
      await controlPanel.locator('input[type="file"]').setInputFiles(longWav);

      await expect(controlPanel.getByRole("heading", { name: "Transcribing…" })).toBeVisible({
        timeout: 60_000,
      });

      // The two real numbers. The audio length is the engine's own measurement
      // of the converted WAV, not the page guessing from the file size.
      await expect(controlPanel.getByText(/\d+s elapsed/)).toBeVisible({ timeout: 60_000 });
      await expect(controlPanel.getByText(/9m \d\ds of audio/)).toBeVisible({ timeout: 60_000 });
      await expect(controlPanel.getByText(/no percentage to show/i)).toBeVisible();

      // And nothing that claims a position in a run nobody is measuring.
      await expect(controlPanel.getByText(/chunk \d+ of \d+/)).toHaveCount(0);
      await expect(controlPanel.locator("p").filter({ hasText: /^\d+%/ })).toHaveCount(0);

      await controlPanel.screenshot({
        path: path.join(GOAL_EVIDENCE_DIR, "transcribe-progress.png"),
        fullPage: true,
        animations: "disabled",
      });

      // Stop the decode rather than paying for the rest of it.
      await controlPanel.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(controlPanel.getByRole("heading", { name: "Cancelled" })).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      fs.rmSync(path.dirname(longWav), { recursive: true, force: true });
    }
  });
});
