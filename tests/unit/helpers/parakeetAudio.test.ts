/**
 * Parakeet aborts on a single decode past ~400 s and returns nothing for quiet
 * audio, so every recording must reach it trimmed, normalised and in pieces of
 * at most 60 s. These run the real FFmpeg and, where noted, the real detector.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { prepareParakeetAudio, TEMP_DIR_PREFIX } = require("../../../src/helpers/parakeetAudio");
const speechRunner = require("../../../src/helpers/dictationSpeechRunner");
const { getFFmpegPath } = require("../../../src/helpers/ffmpegUtils");
const { getSafeTempDir } = require("../../../src/helpers/safeTempDir");
const { createPcm16WavBuffer } = require("../../../src/helpers/wavPcm");

const SR = 16000;

const ffmpegAvailable = (() => {
  try {
    return Boolean(getFFmpegPath());
  } catch {
    return false;
  }
})();

/** A 300 Hz tone at `amplitude` of full scale, with digital silence inside `quiet`. */
function toneWav(seconds: number, amplitude = 0.5, quiet: Array<[number, number]> = []): Buffer {
  const samples = Math.round(seconds * SR);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / SR;
    if (quiet.some(([from, to]) => t >= from && t < to)) continue;
    pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 300 * t) * amplitude * 32767), i * 2);
  }
  return createPcm16WavBuffer(pcm);
}

function peak(chunks: Float32Array[]): number {
  let max = 0;
  for (const chunk of chunks) for (const sample of chunk) max = Math.max(max, Math.abs(sample));
  return max;
}

function leftoverTempDirs(): string[] {
  return fs.readdirSync(getSafeTempDir()).filter((name) => name.startsWith(TEMP_DIR_PREFIX));
}

const detectorUnavailable = () =>
  vi
    .spyOn(speechRunner, "prepareDictationSpeech")
    .mockResolvedValue({ available: false, reason: "model-unavailable" });

afterEach(() => vi.restoreAllMocks());

describe.runIf(ffmpegAvailable)("prepareParakeetAudio", () => {
  it.each([150, 401])(
    "cuts %s s into pieces of at most 60 s that add up to the input",
    async (seconds) => {
      detectorUnavailable();
      const result = await prepareParakeetAudio(toneWav(seconds));

      expect(result.sampleRate).toBe(SR);
      expect(result.speechFound).toBe(true);
      // Seams land between 50 and 60 s, wherever the tone is quietest.
      expect(result.chunks.length).toBeGreaterThanOrEqual(Math.ceil(seconds / 60));
      expect(result.chunks.length).toBeLessThanOrEqual(Math.ceil(seconds / 50));
      expect(result.chunks.every((chunk: Float32Array) => chunk.length <= 60 * SR)).toBe(true);
      const total = result.chunks.reduce((sum: number, c: Float32Array) => sum + c.length, 0);
      expect(total / SR).toBeCloseTo(seconds, 1);
      expect(result.durationSec).toBeCloseTo(total / SR, 5);
      expect(peak(result.chunks)).toBeLessThanOrEqual(1);
    },
    60000
  );

  it("cuts at the quiet spot", async () => {
    detectorUnavailable();
    const result = await prepareParakeetAudio(toneWav(150, 0.5, [[51, 51.5]]));
    const firstSeconds = result.chunks[0].length / SR;

    expect(firstSeconds).toBeGreaterThanOrEqual(51);
    expect(firstSeconds).toBeLessThan(51.5);
  }, 30000);

  it("reports no speech for silence and hands back nothing to decode", async () => {
    const silence = fs.readFileSync(path.resolve("tests/fixtures/dictation/silence.wav"));
    const result = await prepareParakeetAudio(silence);

    expect(result.speechFound).toBe(false);
    expect(result.chunks).toEqual([]);
  }, 30000);

  it("finds speech in a real recording with the bundled detector", async () => {
    const banana = fs.readFileSync(path.resolve("tests/fixtures/dictation/banana.wav"));
    const result = await prepareParakeetAudio(banana);

    expect(result.speechFound).toBe(true);
    expect(result.chunks).toHaveLength(1);
    expect(result.durationSec).toBeGreaterThan(3);
  }, 30000);

  it("makes quiet audio louder", async () => {
    detectorUnavailable();
    const result = await prepareParakeetAudio(toneWav(10, 0.01));

    expect(result.chunks.length).toBe(1);
    expect(peak(result.chunks)).toBeGreaterThan(0.1);
  }, 30000);

  it("still normalises when the detector throws", async () => {
    vi.spyOn(speechRunner, "prepareDictationSpeech").mockRejectedValue(new Error("boom"));
    const result = await prepareParakeetAudio(toneWav(10, 0.01));

    expect(result.chunks.length).toBe(1);
    expect(peak(result.chunks)).toBeGreaterThan(0.1);
  }, 30000);

  it("rejects with isAbort and removes its temp files when cancelled mid-way", async () => {
    const before = leftoverTempDirs();
    const controller = new AbortController();
    const detector = vi
      .spyOn(speechRunner, "prepareDictationSpeech")
      .mockImplementation(async () => {
        // Temp files exist at this point: the input and the converted WAV.
        expect(leftoverTempDirs().length).toBe(before.length + 1);
        controller.abort();
        return { available: false, reason: "cancelled" };
      });

    await expect(
      prepareParakeetAudio(toneWav(5), { signal: controller.signal })
    ).rejects.toMatchObject({ isAbort: true });
    expect(detector).toHaveBeenCalledOnce();
    expect(leftoverTempDirs()).toEqual(before);
  }, 30000);

  it("rejects an already-cancelled request before touching disk", async () => {
    const before = leftoverTempDirs();
    const controller = new AbortController();
    controller.abort();

    await expect(
      prepareParakeetAudio(toneWav(1), { signal: controller.signal })
    ).rejects.toMatchObject({ isAbort: true });
    expect(leftoverTempDirs()).toEqual(before);
  });

  it("removes its temp files after a successful run", async () => {
    const before = leftoverTempDirs();
    detectorUnavailable();
    await prepareParakeetAudio(toneWav(2));
    expect(leftoverTempDirs()).toEqual(before);
  }, 30000);

  it("accepts the WebM/Opus container MediaRecorder produces", async () => {
    detectorUnavailable();
    const dir = fs.mkdtempSync(path.join(getSafeTempDir(), "parakeet-test-"));
    try {
      const wavPath = path.join(dir, "in.wav");
      const webmPath = path.join(dir, "in.webm");
      fs.writeFileSync(wavPath, toneWav(3));
      const { spawnSync } = require("node:child_process");
      const encoded = spawnSync(
        getFFmpegPath(),
        ["-v", "error", "-y", "-i", wavPath, "-c:a", "libopus", webmPath],
        { windowsHide: true }
      );
      expect(encoded.status).toBe(0);

      const result = await prepareParakeetAudio(fs.readFileSync(webmPath));
      expect(result.chunks).toHaveLength(1);
      expect(result.durationSec).toBeGreaterThan(2.9);
      expect(result.durationSec).toBeLessThan(3.2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
