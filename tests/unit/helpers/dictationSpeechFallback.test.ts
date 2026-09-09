import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
const WhisperServerManager = require("../../../src/helpers/whisperServer");
const runner = require("../../../src/helpers/dictationSpeechRunner");

afterEach(() => vi.restoreAllMocks());

describe("dictation speech preparation fallback", () => {
  it.each(["unavailable", "exception"])("keeps the existing audio path on %s", async (failure) => {
    const manager = new WhisperServerManager();
    const input = fs.readFileSync("tests/fixtures/dictation/banana.wav");
    const expected = await manager._convertToWav(input, "speech.wav", {
      trimTrailingSilence: true,
    });
    const probe = vi.spyOn(runner, "prepareDictationSpeech");
    if (failure === "exception") probe.mockRejectedValue(new Error("worker unavailable"));
    else probe.mockResolvedValue({ available: false, reason: "timeout" });
    const result = await manager._convertToWav(input, "speech.wav", {
      speechCleanup: true,
      trimTrailingSilence: true,
    });
    expect(probe).toHaveBeenCalledOnce();
    expect(result.equals(expected)).toBe(true);
  });
  it("does not turn cancellation into a fallback transcription", async () => {
    const controller = new AbortController();
    vi.spyOn(runner, "prepareDictationSpeech").mockImplementation(async () => {
      controller.abort();
      return { available: false, reason: "cancelled" };
    });
    const manager = new WhisperServerManager();
    await expect(
      manager._convertToWav(fs.readFileSync("tests/fixtures/dictation/banana.wav"), "speech.wav", {
        speechCleanup: true,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: "TRANSCRIPTION_CANCELLED", cancelled: true });
  });
  it("does not apply dictation cleanup to file transcription", async () => {
    const probe = vi.spyOn(runner, "prepareDictationSpeech");
    const manager = new WhisperServerManager();
    manager.ready = true;
    manager.process = {};
    manager.canConvert = true;
    manager._scheduleIdleCheck = vi.fn();
    manager._postInference = vi.fn().mockResolvedValue({ text: "spoken file", segments: [] });
    await manager.transcribe(fs.readFileSync("tests/fixtures/dictation/banana.wav"), {
      fileMode: true,
      language: "en",
    });
    expect(probe).not.toHaveBeenCalled();
  });
});
