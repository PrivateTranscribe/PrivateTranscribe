import { describe, expect, it } from "vitest";

const { isAudioConversionFailure } = require("../../../src/helpers/ipcHandlers");

// The local Whisper handler turns these into "Audio conversion failed. The
// recording may be corrupted." Unmatched, the raw FFmpeg output reached the
// toast instead.
describe("isAudioConversionFailure", () => {
  it.each([
    "FFmpeg exited with code 1: [matroska,webm @ 0x1] EBML header parsing failed",
    "FFmpeg exited with code 3199971767",
    "FFmpeg process error: spawn EPERM",
    "FFmpeg conversion produced no output file",
    "FFmpeg conversion produced empty output file",
  ])("matches what convertToWav throws: %j", (message) => {
    expect(isAudioConversionFailure(message)).toBe(true);
  });

  it.each([
    "FFmpeg not found - required for audio conversion",
    "whisper-server request failed: socket hang up",
    undefined,
  ])("leaves other failures alone: %j", (message) => {
    expect(isAudioConversionFailure(message)).toBe(false);
  });
});
