/**
 * Freezes the shape of the committed multi-speaker fixture.
 *
 * tests/fixtures/multispeaker/ is ground truth for every later Track C gate:
 * diarization, speaker labelling, coverage regressions. A truth JSON that
 * quietly stops matching its WAV — an utterance re-ordered, a boundary moved, a
 * clip regenerated shorter — would not fail any of those gates. It would make
 * them measure the wrong thing and still pass.
 *
 * So this test asserts the invariants a consumer is entitled to assume, and it
 * checks them against the audio file itself rather than only against the JSON's
 * own internal consistency. It runs in milliseconds and never touches whisper.
 *
 * If this test fails, the fix is almost never "regenerate the fixture".
 * Regenerating to make a later gate pass is bar-weakening.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const FIXTURE_DIR = path.resolve(__dirname, "../../fixtures/multispeaker");
const SPEAKERS = ["HOST", "GUEST_A", "GUEST_B"] as const;

type Utterance = {
  index: number;
  speaker: string;
  voice: string;
  text: string;
  startSample: number;
  endSample: number;
  startSec: number;
  endSec: number;
};

type Truth = {
  clip: string;
  sampleRate: number;
  totalSec: number;
  totalSamples: number;
  utterances: Utterance[];
};

function readTruth(clip: string): Truth {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${clip}.truth.json`), "utf8"));
}

/** Minimal RIFF reader: enough to prove the WAV is what the truth claims it is. */
function readWavHeader(clip: string) {
  const buffer = fs.readFileSync(path.join(FIXTURE_DIR, `${clip}.wav`));
  return {
    riff: buffer.toString("ascii", 0, 4),
    wave: buffer.toString("ascii", 8, 12),
    audioFormat: buffer.readUInt16LE(20),
    channels: buffer.readUInt16LE(22),
    sampleRate: buffer.readUInt32LE(24),
    bitsPerSample: buffer.readUInt16LE(34),
    dataChunkId: buffer.toString("ascii", 36, 40),
    dataBytes: buffer.readUInt32LE(40),
    fileBytes: buffer.length,
  };
}

describe("multi-speaker fixture truth", () => {
  for (const clip of ["interview", "control"]) {
    describe(clip, () => {
      const truth = readTruth(clip);
      const wav = readWavHeader(clip);

      it("has utterances", () => {
        expect(truth.utterances.length).toBeGreaterThan(0);
        expect(truth.clip).toBe(clip);
      });

      it("every utterance has text, a known speaker and its speaker's voice", () => {
        for (const utterance of truth.utterances) {
          expect(utterance.text.trim().length).toBeGreaterThan(0);
          expect(SPEAKERS).toContain(utterance.speaker as (typeof SPEAKERS)[number]);
          expect(utterance.voice).toMatch(/^[a-z]{2}_[a-z]+$/);
        }
      });

      it("indexes utterances in order from zero", () => {
        expect(truth.utterances.map((u) => u.index)).toEqual(
          truth.utterances.map((_, index) => index)
        );
      });

      it("keeps [startSec, endSec) increasing, non-overlapping and inside the clip", () => {
        let previousEnd = 0;
        for (const utterance of truth.utterances) {
          expect(utterance.startSec).toBeGreaterThanOrEqual(previousEnd);
          expect(utterance.endSec).toBeGreaterThan(utterance.startSec);
          expect(utterance.endSec).toBeLessThanOrEqual(truth.totalSec);
          previousEnd = utterance.endSec;
        }
      });

      it("derives its seconds from its sample offsets", () => {
        for (const utterance of truth.utterances) {
          expect(utterance.endSample).toBeGreaterThan(utterance.startSample);
          expect(utterance.startSec).toBeCloseTo(utterance.startSample / truth.sampleRate, 5);
          expect(utterance.endSec).toBeCloseTo(utterance.endSample / truth.sampleRate, 5);
        }
        expect(truth.totalSec).toBeCloseTo(truth.totalSamples / truth.sampleRate, 5);
      });

      it("matches the audio file it describes", () => {
        expect(wav.riff).toBe("RIFF");
        expect(wav.wave).toBe("WAVE");
        expect(wav.dataChunkId).toBe("data");
        // Plain 16-bit PCM mono, so every consumer can read it without a decoder.
        expect(wav.audioFormat).toBe(1);
        expect(wav.channels).toBe(1);
        expect(wav.bitsPerSample).toBe(16);
        expect(wav.sampleRate).toBe(truth.sampleRate);
        // whisper.cpp's native rate; anything else means a resample crept in.
        expect(truth.sampleRate).toBe(16000);
        expect(wav.dataBytes / 2).toBe(truth.totalSamples);
        expect(wav.fileBytes).toBe(44 + wav.dataBytes);
        // The last utterance ends at the end of the audio: nothing was appended
        // to the file that the truth does not account for.
        expect(truth.utterances[truth.utterances.length - 1].endSample).toBe(truth.totalSamples);
      });
    });
  }

  it("interview holds all three speakers, each with its own voice", () => {
    const truth = readTruth("interview");
    const speakers = new Set(truth.utterances.map((u) => u.speaker));
    expect([...speakers].sort()).toEqual([...SPEAKERS].sort());

    const voiceBySpeaker = new Map<string, string>();
    for (const utterance of truth.utterances) {
      const known = voiceBySpeaker.get(utterance.speaker);
      if (known) expect(utterance.voice).toBe(known);
      else voiceBySpeaker.set(utterance.speaker, utterance.voice);
    }
    expect(new Set(voiceBySpeaker.values()).size).toBe(SPEAKERS.length);
  });

  it("interview runs 60-120s", () => {
    const truth = readTruth("interview");
    expect(truth.totalSec).toBeGreaterThanOrEqual(60);
    expect(truth.totalSec).toBeLessThanOrEqual(120);
  });

  it("control is one speaker in one voice, 30-90s", () => {
    const truth = readTruth("control");
    expect(new Set(truth.utterances.map((u) => u.speaker)).size).toBe(1);
    expect(new Set(truth.utterances.map((u) => u.voice)).size).toBe(1);
    expect(truth.totalSec).toBeGreaterThanOrEqual(30);
    expect(truth.totalSec).toBeLessThanOrEqual(90);
  });

  it("separates utterances by the generator's fixed silence pattern", () => {
    // 450/650ms alternating, no RNG. Asserting the exact values rather than a
    // range is the point: it pins the boundaries so a later diarization gate is
    // scored against silence it can actually find.
    for (const clip of ["interview", "control"]) {
      const truth = readTruth(clip);
      const allowed = [0.45, 0.65].map((seconds) => Math.round(seconds * truth.sampleRate));
      for (let i = 1; i < truth.utterances.length; i += 1) {
        const gap = truth.utterances[i].startSample - truth.utterances[i - 1].endSample;
        expect(allowed).toContain(gap);
      }
    }
  });
});
