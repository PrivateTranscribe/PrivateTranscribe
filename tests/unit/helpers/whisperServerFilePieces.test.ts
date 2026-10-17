import { afterEach, describe, expect, it, vi } from "vitest";
const WhisperServerManager = require("../../../src/helpers/whisperServer");
const runner = require("../../../src/helpers/dictationSpeechRunner");
const { createPcm16WavBuffer } = require("../../../src/helpers/wavPcm");

afterEach(() => vi.restoreAllMocks());

const SAMPLE_RATE = 16000;
const at = (from: number, to: number) => ({ start: from * SAMPLE_RATE, end: to * SAMPLE_RATE });

function setUp(seconds: number) {
  const manager = new WhisperServerManager();
  manager.ready = true;
  manager.process = {};
  manager.canConvert = true;
  manager._scheduleIdleCheck = vi.fn();
  const wav = createPcm16WavBuffer(Buffer.alloc(seconds * SAMPLE_RATE * 2, 1));
  manager._convertToWav = vi.fn().mockResolvedValue(wav);
  manager._postInference = vi.fn().mockImplementation(async (_buffer: Buffer, options: any) => ({
    text: `piece ${options.chunkIndex + 1}`,
    segments: [{ start: 0, end: 1, text: `piece ${options.chunkIndex + 1}` }],
  }));
  return manager;
}

describe("Whisper file transcription in speech pieces", () => {
  it("sends only the speech, in pieces, with timestamps on the file's own timeline", async () => {
    const detect = vi
      .spyOn(runner, "detectSpeechRegionsIsolated")
      .mockResolvedValue({ available: true, regions: [at(2, 20), at(70, 80)] });
    const manager = setUp(100);

    const progress: any[] = [];
    const result = await manager.transcribe(Buffer.from("file"), {
      fileMode: true,
      language: "da",
      onProgress: (update: any) => progress.push(update),
    });

    expect(detect).toHaveBeenCalledOnce();
    // The page names the file's length, not the 29 s of speech inside it.
    expect(progress.find((update) => update.stage === "transcribing").audioSeconds).toBe(100);
    expect(manager._postInference).toHaveBeenCalledTimes(2);
    const sentSeconds = manager._postInference.mock.calls.map(
      ([, options]: any) => options.durationSeconds
    );
    expect(sentSeconds[0]).toBeCloseTo(18.5, 3);
    expect(sentSeconds[1]).toBeCloseTo(10.5, 3);
    expect(result.segments.map((segment: any) => segment.start)).toEqual([1.75, 69.75]);
    expect(result.text).toBe("piece 1 piece 2");
  });

  it.each([
    ["the detector is unavailable", { available: false, reason: "timeout" }],
    ["the detector heard nothing", { available: true, regions: [] }],
  ])("sends all the audio when %s", async (_case, detected) => {
    vi.spyOn(runner, "detectSpeechRegionsIsolated").mockResolvedValue(detected);
    const manager = setUp(100);

    await manager.transcribe(Buffer.from("file"), { fileMode: true, language: "da" });

    expect(manager._postInference).toHaveBeenCalledOnce();
    expect(manager._postInference.mock.calls[0][1].durationSeconds).toBeCloseTo(100, 3);
  });

  it.each([
    ["stereo diarization", { diarize: true }],
    ["tinydiarize speaker turns", { speakerDetection: true }],
    ["the old path on request", { speechPieces: false }],
    ["a dictation", { fileMode: false }],
  ])("leaves %s alone", async (_case, options) => {
    const detect = vi.spyOn(runner, "detectSpeechRegionsIsolated");
    const manager = setUp(30);

    await manager.transcribe(Buffer.from("file"), { fileMode: true, language: "da", ...options });

    expect(detect).not.toHaveBeenCalled();
  });

  it("turns a cancel during speech detection into a cancel, not a whole-file decode", async () => {
    const controller = new AbortController();
    vi.spyOn(runner, "detectSpeechRegionsIsolated").mockImplementation(async () => {
      controller.abort();
      return { available: false, reason: "cancelled" };
    });
    const manager = setUp(100);

    await expect(
      manager.transcribe(Buffer.from("file"), {
        fileMode: true,
        language: "da",
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ cancelled: true });
    expect(manager._postInference).not.toHaveBeenCalled();
  });
});
