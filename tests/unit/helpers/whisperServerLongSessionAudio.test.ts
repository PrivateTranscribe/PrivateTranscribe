import { describe, expect, it } from "vitest";

const WhisperServerManager = require("../../../src/helpers/whisperServer");

describe("Whisper server long-session audio preparation", () => {
  it("applies trailing-silence trimming in a separate pass after WebM normalization", () => {
    expect(
      WhisperServerManager.getTranscriptionAudioFilters({ trimTrailingSilence: true })
    ).toEqual([]);
    expect(WhisperServerManager.getTrailingSilenceFilters()).toEqual([
      "areverse",
      "silenceremove=start_periods=1:start_duration=0.5:start_threshold=-50dB",
      "areverse",
      "apad=pad_dur=0.8",
    ]);
  });

  it("leaves a short pause after the last word so the tail cannot run on", () => {
    const filters = WhisperServerManager.getTrailingSilenceFilters();

    expect(filters[filters.length - 1]).toMatch(/^apad=pad_dur=/);
    expect(
      filters.indexOf("silenceremove=start_periods=1:start_duration=0.5:start_threshold=-50dB")
    ).toBeLessThan(filters.length - 1);
  });

  it("does not trim ordinary short dictations", () => {
    expect(WhisperServerManager.getTranscriptionAudioFilters({})).toEqual([]);
  });
});
