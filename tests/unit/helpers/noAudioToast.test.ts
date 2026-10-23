import { describe, expect, it } from "vitest";

const { shouldToastNoAudio } = require("../../../src/helpers/ipcHandlers");

const noAudio = { success: false, message: "No audio detected" };

describe("shouldToastNoAudio", () => {
  it("toasts a dictation that held no audio", () => {
    expect(shouldToastNoAudio(noAudio, { model: "base" })).toBe(true);
    expect(shouldToastNoAudio(noAudio, undefined)).toBe(true);
  });

  it("stays quiet for a silent minute inside a long dictation", () => {
    // The dictation still pastes what was said around the silent minute, so a
    // "No Audio Detected" toast over it says the opposite of what happened.
    expect(shouldToastNoAudio(noAudio, { model: "base", longSessionChunk: true })).toBe(false);
  });

  it("stays quiet for transcripts and other failures", () => {
    expect(shouldToastNoAudio({ success: true, text: "hello" }, {})).toBe(false);
    expect(
      shouldToastNoAudio({ success: false, message: "Audio conversion failed." }, {})
    ).toBe(false);
  });
});
