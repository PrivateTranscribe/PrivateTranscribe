import { describe, expect, it } from "vitest";

const WhisperServerManager = require("../../../src/helpers/whisperServer");

describe("Whisper server long-session audio preparation", () => {
  it("applies trailing-silence trimming in a separate pass after WebM normalization", () => {
    expect(
      WhisperServerManager.getTranscriptionAudioFilters({ trimTrailingSilence: true })
    ).toEqual([]);
    expect(WhisperServerManager.getTrailingSilenceFilters()).toEqual([
      "areverse",
      "silenceremove=start_periods=1:start_duration=0:start_threshold=-50dB:start_silence=0.8",
      "areverse",
    ]);
  });

  it("never trims real speech off the end of the recording", () => {
    // start_duration is the amount of non-silence FFmpeg observes before it
    // stops trimming, and that audio is discarded. Anything above 0 silently
    // deletes the final words of the dictation.
    const [, silenceRemove] = WhisperServerManager.getTrailingSilenceFilters();

    expect(silenceRemove).toContain("start_duration=0:");
    expect(silenceRemove).not.toMatch(/start_duration=(?!0:)/);
  });

  it("leaves a short pause after the last word so the tail cannot run on", () => {
    const [, silenceRemove] = WhisperServerManager.getTrailingSilenceFilters();

    expect(silenceRemove).toMatch(/start_silence=0\.\d+$/);
  });

  it("does not trim ordinary short dictations", () => {
    expect(WhisperServerManager.getTranscriptionAudioFilters({})).toEqual([]);
  });
});
