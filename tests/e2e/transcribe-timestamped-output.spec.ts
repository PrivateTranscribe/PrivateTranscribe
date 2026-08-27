import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";

/**
 * Verifies audit finding F2 at the layer the user reads it: the Transcribe
 * page's default output (speaker labels off, which sends outputFormat
 * "timestamped") must stamp every segment rather than folding the whole file
 * into one line at [00:00:00].
 *
 * This is the one spec that decodes real audio. It uses the committed 46.8s
 * control fixture and the machine's own ggml-base.bin, and forces
 * WHISPER_FORCE_CPU so the run spawns its own CPU whisper-server on a free
 * port — it never contends with a CUDA engine or with the whisper-server the
 * installed app may already be running.
 */
test.use({ appEnv: { WHISPER_FORCE_CPU: "true" } });

const CONTROL_WAV = path.resolve(__dirname, "..", "fixtures", "multispeaker", "control.wav");
const BASE_MODEL = path.join(
  os.homedir(),
  ".cache",
  "PrivateTranscribe",
  "whisper-models",
  "ggml-base.bin"
);

test.describe("Transcribe page default output", () => {
  test("stamps every segment instead of one line for the whole file", async ({ controlPanel }) => {
    // No silent skip: a machine without the model should say so, not report a
    // pass it never earned.
    expect(
      fs.existsSync(BASE_MODEL),
      `ggml-base.bin is not installed at ${BASE_MODEL} — download it before running this spec`
    ).toBe(true);

    await controlPanel.evaluate(() => {
      localStorage.setItem("useLocalWhisper", "true");
      localStorage.setItem("whisperModel", "base");
      localStorage.setItem("fileTranscriptionLanguage", "en");
      localStorage.setItem("fileTranscriptionSpeakerDetection", "false");
    });
    await controlPanel.reload({ waitUntil: "domcontentloaded" });
    await controlPanel.getByRole("button", { name: "Transcribe File", exact: true }).click();
    await controlPanel.locator('input[type="file"]').setInputFiles(CONTROL_WAV);

    await expect(controlPanel.getByRole("heading", { name: "Done" })).toBeVisible({
      timeout: 120_000,
    });

    const transcript = await controlPanel.locator("textarea[readonly]").inputValue();
    const lines = transcript.split("\n").filter(Boolean);

    // Before the fix this was exactly one line, whatever the file's length.
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) {
      expect(line).toMatch(/^\[\d{2}:\d{2}:\d{2}\] /);
    }
    // Stamps must advance: a collapsed transcript stamps everything [00:00:00].
    expect(new Set(lines.map((line) => line.slice(0, 10))).size).toBeGreaterThan(1);

    await controlPanel.screenshot({
      path: "test-results/e2e/transcribe-timestamped-output.png",
      fullPage: true,
    });

    const transcriptPanel = controlPanel.locator("section", { hasText: "Transcript" }).last();
    await transcriptPanel.scrollIntoViewIfNeeded();
    await transcriptPanel.screenshot({
      path: "test-results/e2e/transcribe-timestamped-transcript.png",
    });
  });
});
