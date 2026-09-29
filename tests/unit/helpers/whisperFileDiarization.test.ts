import { describe, expect, it, vi } from "vitest";

const WhisperManager = require("../../../src/helpers/whisper");

function harness() {
  return {
    isModelDownloaded: () => true,
    transcribeLocalWhisper: vi
      .fn()
      .mockResolvedValue({
        success: true,
        text: "Ja",
        segments: [{ start: 0, end: 1, text: "Ja" }],
      }),
    audioBlobToBuffer: vi.fn().mockResolvedValue(Buffer.from("wav")),
    serverManager: { convertToDiarizationWav: vi.fn().mockResolvedValue(Buffer.from("wav")) },
    diarizationManager: {
      buildConfig: vi.fn(),
      diarizeWavBufferInWorker: vi
        .fn()
        .mockResolvedValue({
          engine: "sherpa-onnx",
          speakerCount: 1,
          segments: [{ start: 0, end: 1, speaker: "SPEAKER_00" }],
        }),
    },
  };
}

describe("file diarization integration", () => {
  it.each(["da", "en", "ja", "auto"])(
    "keeps %s on multilingual detection when labels are requested",
    async (language) => {
      const manager = harness();
      const result = await WhisperManager.prototype.transcribeFileV2.call(
        manager,
        Buffer.from("wav"),
        { speakerDetection: true, language, model: "base" }
      );
      expect(result.speakerDetectionMode).toBe("local-diarization");
      expect(result.segments[0].speaker).toBe("Speaker 1");
      expect(manager.transcribeLocalWhisper.mock.calls[0][1]).toMatchObject({
        language,
        model: "base",
        speakerDetection: false,
      });
    }
  );

  it.each(["auto", "da", "ja"])(
    "rejects English-only detection for %s before decoding",
    async (language) => {
      const manager = harness();
      await expect(
        WhisperManager.prototype.transcribeFileV2.call(manager, Buffer.from("wav"), {
          speakerDetectionMode: "tiny-diarize-en",
          language,
        })
      ).rejects.toThrow(/requires English/);
      expect(manager.transcribeLocalWhisper).not.toHaveBeenCalled();
    }
  );

  it("reports missing models before spending time transcribing", async () => {
    const manager = harness();
    manager.diarizationManager.buildConfig.mockImplementation(() => {
      throw new Error("Models not downloaded");
    });
    await expect(
      WhisperManager.prototype.transcribeFileV2.call(manager, Buffer.from("wav"), {
        speakerDetection: true,
      })
    ).rejects.toThrow(/not downloaded/);
    expect(manager.transcribeLocalWhisper).not.toHaveBeenCalled();
  });

  it("passes cancellation through the worker and rejects a late result", async () => {
    const manager = harness();
    const controller = new AbortController();
    const progress = vi.fn();
    manager.diarizationManager.diarizeWavBufferInWorker.mockImplementation(
      async (_audio, options) => {
        expect(options.signal).toBe(controller.signal);
        controller.abort();
        return { engine: "sherpa-onnx", speakerCount: 0, segments: [] };
      }
    );
    await expect(
      WhisperManager.prototype.transcribeFileV2.call(manager, Buffer.from("wav"), {
        speakerDetection: true,
        signal: controller.signal,
        onProgress: progress,
      })
    ).rejects.toMatchObject({ cancelled: true });
    expect(progress).not.toHaveBeenCalledWith({ stage: "diarizing", percentage: 100 });
  });
});
