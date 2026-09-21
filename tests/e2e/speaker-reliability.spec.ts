import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/electron-app";

const root = path.resolve(".");
const evidence = path.join(root, "tmp/speaker-comparison/validation");
test.use({ appEnv: { WHISPER_FORCE_CPU: "true" } });
test.skip(
  process.env.PT_SPEAKER_RELIABILITY !== "1",
  "Requires local Whisper base, speaker models, AMI and prepared Danish validation audio"
);

test.beforeAll(() => {
  const sources = JSON.parse(
    fs.readFileSync(path.join(root, "scripts/speaker-benchmark/reliability-sources.json"), "utf8")
  );
  for (const sample of sources.rows) {
    const file = path.join(evidence, `da-${sample.index}.wav`);
    expect(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")).toBe(
      sample.wavSha256
    );
  }
  const meeting = fs.readFileSync(path.join(root, "tmp/speaker-comparison/sources/ES2004a.wav"));
  expect(crypto.createHash("sha256").update(meeting).digest("hex")).toBe(
    "3e2560b19bee6952c7c7ce041b0f1ea8a7ea9468044c4eea79d2a2c67e24ab0f"
  );
});

// Exercise the real preload/IPC/worker/formatter path without substituting inference.
async function transcribe(
  page: Page,
  name: string,
  file: string,
  options = {},
  cancel = false,
  outputDir = evidence
) {
  await page.evaluate(() => {
    document.getElementById("speaker-test-file")?.remove();
    const input = document.createElement("input");
    input.id = "speaker-test-file";
    input.type = "file";
    input.hidden = true;
    document.body.appendChild(input);
  });
  await page.locator("#speaker-test-file").setInputFiles(file);
  const captured = await page.evaluate(
    async ({ options, cancel, name }) => {
      const api = (window as any).electronAPI;
      await api.setWhisperForceCpu(true);
      const file = (document.getElementById("speaker-test-file") as HTMLInputElement).files![0];
      const jobId = `reliability-${name}`;
      const progress: any[] = [];
      let cancellationRequested = false;
      let cancelReply: any = null;
      const remove = api.onFileTranscriptionProgress((_ipcEvent: unknown, event: any) => {
        progress.push(event);
        if (cancel && !cancellationRequested && event.stage === "diarizing") {
          cancellationRequested = true;
          void api.cancelFileTranscription(jobId).then((reply: any) => (cancelReply = reply));
        }
      });
      const started = performance.now();
      try {
        const result = await api.transcribeFileV2(await file.arrayBuffer(), {
          model: "base",
          language: "auto",
          speakerDetection: true,
          speakerDetectionMode: "local-diarization",
          outputFormat: "speakers",
          noiseReduction: false,
          inputFileName: file.name,
          jobId,
          ...options,
        });
        return {
          result,
          progress,
          cancellationRequested,
          cancelReply,
          elapsedMs: performance.now() - started,
        };
      } finally {
        remove?.();
      }
    },
    { options, cancel, name }
  );
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, `${name}.json`), JSON.stringify(captured, null, 2));
  return captured;
}

function validResult(result: any) {
  expect(result.success, result.error).toBe(true);
  expect(result.speakerDetectionMode).toBe("local-diarization");
  expect(result.speakerDetectionActive).toBe(true);
  const named = new Set(
    result.segments.map((s: any) => s.speaker).filter((s: string) => s && s !== "Unknown speaker")
  );
  expect(result.speakerCount).toBe(named.size);
  for (const segment of result.segments) {
    expect(Number.isFinite(segment.start)).toBe(true);
    expect(Number.isFinite(segment.end)).toBe(true);
    expect(segment.start).toBeGreaterThanOrEqual(0);
    expect(segment.end).toBeGreaterThanOrEqual(segment.start);
    expect(segment.end).toBeLessThanOrEqual(result.diarization.durationSec + 0.1);
  }
}

test("silent audio produces no invented speech or speakers", async ({ controlPanel }, info) => {
  test.setTimeout(120_000);
  const wav = Buffer.alloc(44 + 16000 * 2 * 10);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  const file = info.outputPath("silence.wav");
  fs.writeFileSync(file, wav);
  const { result } = await transcribe(controlPanel, "silence", file);
  expect(result.success).toBe(false);
  expect(result.message).toBe("No audio detected");
  expect(result.text || "").toBe("");
  expect(result.speakerCount || 0).toBe(0);
  expect(result.speakerDetectionActive).toBe(false);
});

test("Danish transcript keeps words whole across subtitle segments", async ({
  controlPanel,
}, info) => {
  test.setTimeout(120_000);
  await controlPanel.evaluate(() => {
    localStorage.setItem("useLocalWhisper", "true");
    localStorage.setItem("whisperModel", "base");
    localStorage.setItem("fileTranscriptionLanguage", "da");
    localStorage.setItem("fileTranscriptionSpeakerDetection", "true");
    localStorage.setItem("fileTranscriptionSpeakerDetectionMode", "local-diarization");
    localStorage.setItem("fileTranscriptionNoiseReduction", "false");
  });
  await controlPanel.reload({ waitUntil: "domcontentloaded" });
  await controlPanel.evaluate(() => (window as any).electronAPI.setWhisperForceCpu(true));
  await controlPanel.getByRole("button", { name: "Transcribe File", exact: true }).click();
  await controlPanel.locator('input[type="file"]').setInputFiles(path.join(evidence, "da-0.wav"));
  await expect(controlPanel.getByRole("heading", { name: "Done" })).toBeVisible({
    timeout: 90_000,
  });
  const text = await controlPanel.locator("textarea[readonly]").inputValue();
  const imageDir = process.env.PT_SPEAKER_EVIDENCE_DIR || info.outputDir;
  fs.mkdirSync(imageDir, { recursive: true });
  await controlPanel.locator("textarea[readonly]").scrollIntoViewIfNeeded();
  await controlPanel.screenshot({
    path: path.join(
      imageDir,
      `${process.env.PT_SPEAKER_CAPTURE_PHASE || "after"}-danish-whole-words.png`
    ),
    fullPage: true,
  });
  if (process.env.PT_SPEAKER_CAPTURE_PHASE !== "before") {
    expect(text).toContain("objektiver");
    expect(text).not.toContain("objekt iver");
  }
});

test("one speaker and an exact count survive the complete file pipeline", async ({
  controlPanel,
}) => {
  test.setTimeout(180_000);
  const file = path.join(root, "tests/fixtures/multispeaker/control.wav");
  for (const [name, options] of [
    ["single-auto", {}],
    ["single-exact", { expectedSpeakers: 1 }],
  ] as const) {
    const { result } = await transcribe(controlPanel, name, file, options);
    validResult(result);
    expect(result.speakerCount).toBe(1);
    expect(result.text).not.toContain("Unknown speaker");
  }
});

test("a supplied three-speaker count reaches the native engine", async ({ controlPanel }) => {
  test.setTimeout(180_000);
  const { result } = await transcribe(
    controlPanel,
    "three-exact",
    path.join(root, "tests/fixtures/multispeaker/interview.wav"),
    { expectedSpeakers: 3 }
  );
  validResult(result);
  expect(result.diarization.config.numClusters).toBe(3);
  expect(result.diarization.speakerCount).toBe(3);
  expect(result.speakerCount).toBe(3);
});

test("Danish read speech works with explicit and automatic language", async ({ controlPanel }) => {
  test.setTimeout(300_000);
  for (let index = 0; index < 6; index++) {
    const file = path.join(evidence, `da-${index}.wav`);
    for (const language of ["auto", "da"]) {
      const { result } = await transcribe(controlPanel, `danish-${index}-${language}`, file, {
        language,
      });
      validResult(result);
      expect(result.text.trim()).not.toBe("");
      expect(result.requestedLanguage).toBe(language);
      // Accuracy is scored against frozen references, not asserted by matching model output.
    }
  }
});

test("Whisper Turbo processes the same Danish clips with automatic language", async ({
  controlPanel,
}) => {
  test.setTimeout(600_000);
  for (let index = 0; index < 6; index++) {
    const { result } = await transcribe(
      controlPanel,
      `danish-${index}-turbo-auto`,
      path.join(evidence, `da-${index}.wav`),
      { model: "turbo" }
    );
    validResult(result);
    expect(result.model).toBe("turbo");
    expect(result.text.trim()).not.toBe("");
    expect(result.languageDetection?.detected).toBe("da");
  }
});

// Simulated Danish conversations built by scripts/speaker-benchmark/prepare-danish-multi.py.
// Accuracy is scored afterwards by score-danish-multi.py; here we only assert the
// pipeline completed and the speaker controls reached the native engine.
test("Danish multi-speaker fixtures run with automatic and supplied counts", async ({
  controlPanel,
}) => {
  test.skip(process.env.PT_SPEAKER_DANISH_MULTI !== "1", "Needs prepared Danish multi fixtures");
  test.setTimeout(1_800_000);
  const fixtures = path.join(evidence, "multi/fixtures");
  const results = path.join(evidence, "multi/results");
  const manifest = JSON.parse(fs.readFileSync(path.join(fixtures, "manifest.json"), "utf8"));
  const label = process.env.PT_SPEAKER_RUN_LABEL || "app";
  for (const entry of manifest) {
    const file = path.join(fixtures, `${entry.name}.wav`);
    expect(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")).toBe(
      entry.wavSha256
    );
    for (const [mode, options] of [
      ["auto", {}],
      ["exact", { expectedSpeakers: entry.speakers }],
    ] as const) {
      const { result } = await transcribe(
        controlPanel,
        `${entry.name}-${label}-${mode}`,
        file,
        { model: "turbo", ...options },
        false,
        results
      );
      validResult(result);
      expect(result.model).toBe("turbo");
      expect(result.languageDetection?.detected).toBe("da");
      if (mode === "exact") {
        // The supplied count reaches the native engine, but sherpa-onnx can still
        // return fewer clusters than requested; the scorer records what came back.
        expect(result.diarization.config.numClusters).toBe(entry.speakers);
        expect(result.diarization.speakerCount).toBeLessThanOrEqual(entry.speakers);
      }
    }
  }
});

test("cancelling speaker analysis releases the job and permits another transcription", async ({
  controlPanel,
}) => {
  test.setTimeout(180_000);
  const longFile = path.join(root, "tmp/speaker-comparison/sources/ES2004a.wav");
  const cancelled = await transcribe(controlPanel, "cancel", longFile, {}, true);
  expect(cancelled.cancellationRequested).toBe(true);
  expect(cancelled.result.cancelled).toBe(true);
  expect(cancelled.result.success).toBe(false);
  const stale = await controlPanel.evaluate(() =>
    (window as any).electronAPI.cancelFileTranscription("reliability-cancel")
  );
  expect(stale.jobs).toBe(0);
  const { result } = await transcribe(
    controlPanel,
    "after-cancel",
    path.join(root, "tests/fixtures/multispeaker/control.wav")
  );
  validResult(result);
  expect(result.speakerCount).toBe(1);
});

test("a full meeting preserves timestamps and transcript through many chunk boundaries", async ({
  controlPanel,
}) => {
  test.setTimeout(600_000);
  const file = path.join(root, "tmp/speaker-comparison/sources/ES2004a.wav");
  const { result, progress } = await transcribe(controlPanel, "long-meeting-auto", file);
  validResult(result);
  expect(result.diarization.durationSec).toBeGreaterThan(1000);
  expect(result.segments.length).toBeGreaterThan(100);
  expect(Math.max(...result.segments.map((s: any) => s.end))).toBeGreaterThan(1000);
  expect(progress.some((p: any) => p.stage === "diarizing")).toBe(true);
  expect(result.srt).toContain("00:16:");
});
