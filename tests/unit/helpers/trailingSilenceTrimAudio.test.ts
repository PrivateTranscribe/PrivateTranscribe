import { describe, expect, it } from "vitest";

const WhisperServerManager = require("../../../src/helpers/whisperServer");
const { getFFmpegPath } = require("../../../src/helpers/ffmpegUtils");

const SAMPLE_RATE = 16000;
const FULL_SCALE = 32767;

/** Builds a 16 kHz mono PCM16 WAV: `toneSeconds` of tone, then `silenceSeconds` of digital silence. */
function buildWav(toneSeconds: number, silenceSeconds: number): Buffer {
  const toneSamples = Math.round(toneSeconds * SAMPLE_RATE);
  const silenceSamples = Math.round(silenceSeconds * SAMPLE_RATE);
  const total = toneSamples + silenceSamples;
  const pcm = Buffer.alloc(total * 2);

  for (let i = 0; i < toneSamples; i += 1) {
    // 440 Hz at half scale — comfortably above the -50 dB trim threshold.
    pcm.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE) * 0.5 * FULL_SCALE),
      i * 2
    );
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/** Locates the data chunk without assuming a fixed 44-byte header. */
function readPcm(wav: Buffer): { samples: number; lastAudibleSecond: number; seconds: number } {
  let offset = 12;
  let dataStart = -1;
  let dataSize = 0;

  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "data") {
      dataStart = offset + 8;
      dataSize = Math.min(size, wav.length - dataStart);
      break;
    }
    offset += 8 + size + (size % 2);
  }

  if (dataStart < 0) throw new Error("no data chunk in trimmed WAV");

  const samples = Math.floor(dataSize / 2);
  // 1% of full scale — well above the -50 dB (~0.3%) trim threshold, so
  // resampler ringing at the tone edge is not mistaken for audio.
  const audibleThreshold = 0.01 * FULL_SCALE;
  let lastAudible = -1;
  for (let i = 0; i < samples; i += 1) {
    if (Math.abs(wav.readInt16LE(dataStart + i * 2)) > audibleThreshold) lastAudible = i;
  }

  return {
    samples,
    lastAudibleSecond: lastAudible < 0 ? 0 : lastAudible / SAMPLE_RATE,
    seconds: samples / SAMPLE_RATE,
  };
}

const ffmpegAvailable = (() => {
  try {
    return Boolean(getFFmpegPath());
  } catch {
    return false;
  }
})();

// Runs the real FFmpeg trim. This is the behaviour that unit-level filter-string
// assertions cannot cover: `silenceremove` with a non-zero `start_duration`
// silently deletes that much real audio from the end of the recording, which is
// what made Whisper invent an ending for it.
describe.runIf(ffmpegAvailable)("Trailing-silence trim over real audio", () => {
  it("keeps every spoken sample and leaves only a short pause", async () => {
    const manager = new WhisperServerManager();

    const trimmed = await manager._convertToWav(buildWav(3, 2), "dictation.wav", {
      trimTrailingSilence: true,
    });
    const { lastAudibleSecond, seconds } = readPcm(trimmed);

    // No speech eaten: audio still runs to the 3s mark it was recorded to.
    expect(lastAudibleSecond).toBeGreaterThan(2.95);
    // And the 2s of silence is cut back to a short, bounded pause.
    expect(seconds).toBeGreaterThan(3.5);
    expect(seconds).toBeLessThan(4.1);
  }, 30000);

  it("does not trim when trimming was not requested", async () => {
    const manager = new WhisperServerManager();

    const converted = await manager._convertToWav(buildWav(3, 2), "dictation.wav", {});

    expect(readPcm(converted).seconds).toBeGreaterThan(4.9);
  }, 30000);

  it("hands back an empty result for a silent long-session chunk", async () => {
    const manager = new WhisperServerManager();

    // A silent stretch mid-dictation must not be transcribed. Whisper answers
    // pure silence with filler like "Thank you." dropped into the transcript.
    const trimmed = await manager._convertToWav(buildWav(0, 3), "chunk.wav", {
      trimTrailingSilence: true,
      dropSilentResult: true,
    });

    expect(readPcm(trimmed).samples).toBe(0);
  }, 30000);

  it("falls back to the untrimmed audio when the recording is silent end to end", async () => {
    const manager = new WhisperServerManager();

    // Trimming this to nothing would leave Whisper with an empty file.
    const trimmed = await manager._convertToWav(buildWav(0, 3), "dictation.wav", {
      trimTrailingSilence: true,
    });

    expect(trimmed.length).toBeGreaterThan(44);
    expect(readPcm(trimmed).seconds).toBeGreaterThan(2.9);
  }, 30000);
});
