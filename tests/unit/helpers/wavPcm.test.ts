import { describe, expect, it } from "vitest";

const {
  createPcm16WavBuffer,
  parseWavPcmInfo,
  pcm16ToFloat32,
  planSpeechPieces,
  splitWavIntoChunks,
} = require("../../../src/helpers/wavPcm");

const SAMPLE_RATE = 16000;
const BYTE_RATE = SAMPLE_RATE * 2;
// The settings parakeetAudio uses: aim at 55 s, search 5 s, never exceed 60 s.
const PARAKEET = { chunkSeconds: 55, thresholdSeconds: 60, searchSeconds: 5, maxChunkSeconds: 60 };

/** Loud alternating PCM16 throughout, except digital silence inside `quiet` windows. */
function makeWav(seconds: number, quiet: Array<[number, number]> = []): Buffer {
  const pcm = Buffer.alloc(Math.floor(BYTE_RATE * seconds));
  for (let i = 0; i + 2 <= pcm.length; i += 2) {
    const t = i / BYTE_RATE;
    const silent = quiet.some(([from, to]) => t >= from && t < to);
    pcm.writeInt16LE(silent ? 0 : (i / 2) % 2 === 0 ? 12000 : -12000, i);
  }
  return createPcm16WavBuffer(pcm);
}

describe("splitWavIntoChunks for Parakeet", () => {
  it.each([150, 401, 60.5, 119.4])(
    "cuts %s s into contiguous pieces of at most 60 s",
    (seconds) => {
      const wav = makeWav(seconds);
      const chunks = splitWavIntoChunks(wav, PARAKEET);

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((chunk) => chunk.durationSeconds <= 60)).toBe(true);
      const total = chunks.reduce((sum: number, chunk: any) => sum + chunk.durationSeconds, 0);
      expect(total).toBeCloseTo(seconds, 3);
      // No audio dropped or duplicated at a seam.
      expect(
        Buffer.concat(chunks.map((chunk) => chunk.buffer.subarray(44))).equals(wav.subarray(44))
      ).toBe(true);
    }
  );

  it("moves each seam to the quiet spot nearest the target", () => {
    // Pauses at 52 s and, relative to the second chunk's start, 58 s later.
    const chunks = splitWavIntoChunks(
      makeWav(150, [
        [52, 52.4],
        [110, 110.4],
      ]),
      PARAKEET
    );

    expect(chunks[0].durationSeconds).toBeGreaterThanOrEqual(52);
    expect(chunks[0].durationSeconds).toBeLessThan(52.4);
    expect(chunks[1].offsetSeconds + chunks[1].durationSeconds).toBeGreaterThanOrEqual(110);
    expect(chunks[1].offsetSeconds + chunks[1].durationSeconds).toBeLessThan(110.4);
  });

  it("ignores a pause past the 60 s ceiling", () => {
    const chunks = splitWavIntoChunks(makeWav(150, [[61, 61.5]]), PARAKEET);
    expect(chunks[0].durationSeconds).toBeLessThanOrEqual(60);
  });

  it("splits off a short tail rather than exceed the ceiling", () => {
    // A 59.5 s seam followed by 0.6 s would merge into 60.1 s without the cap.
    const chunks = splitWavIntoChunks(makeWav(60.1, [[59.5, 59.52]]), {
      ...PARAKEET,
      thresholdSeconds: 1,
    });
    expect(chunks.every((chunk) => chunk.durationSeconds <= 60)).toBe(true);
    const total = chunks.reduce((sum: number, chunk: any) => sum + chunk.durationSeconds, 0);
    expect(total).toBeCloseTo(60.1, 3);
  });

  it("leaves audio at or under the threshold whole", () => {
    expect(splitWavIntoChunks(makeWav(60), PARAKEET)).toHaveLength(1);
  });

  it("keeps Whisper's defaults: 60 s target with a seam up to 5 s later", () => {
    const chunks = splitWavIntoChunks(makeWav(150, [[64, 64.5]]), {
      chunkSeconds: 60,
      thresholdSeconds: 90,
    });
    expect(chunks[0].durationSeconds).toBeGreaterThan(63.9);
    expect(chunks[0].durationSeconds).toBeLessThan(64.6);
  });
});

describe("planSpeechPieces", () => {
  const at = (from: number, to: number) => ({ start: from * SAMPLE_RATE, end: to * SAMPLE_RATE });

  it("packs neighbouring speech into pieces of at most 30 s and skips the gaps", () => {
    const wav = makeWav(100);
    const pieces = planSpeechPieces(
      wav,
      [at(1, 10), at(11, 20), at(22, 29), at(40, 50), at(80, 85)],
      { maxSeconds: 30, padSeconds: 0 }
    );

    expect(pieces.map((p: any) => [p.offsetSeconds, p.durationSeconds])).toEqual([
      [1, 28],
      [40, 10],
      [80, 5],
    ]);
    // Each piece is the original audio at its original place.
    expect(
      pieces[1].buffer.subarray(44).equals(wav.subarray(44 + 40 * BYTE_RATE, 44 + 50 * BYTE_RATE))
    ).toBe(true);
  });

  it("cuts a region with no pause at its quietest point, inside the limit", () => {
    // Speech from 0 to 70 s with one short dip at 27 s.
    const wav = makeWav(70, [[27, 27.1]]);
    const pieces = planSpeechPieces(wav, [at(0, 70)], { maxSeconds: 30, padSeconds: 0 });

    expect(pieces[0].durationSeconds).toBeCloseTo(27, 1);
    expect(pieces.every((p: any) => p.durationSeconds <= 30)).toBe(true);
    const total = pieces.reduce((sum: number, p: any) => sum + p.durationSeconds, 0);
    expect(total).toBeCloseTo(70, 3);
    expect(
      Buffer.concat(pieces.map((p: any) => p.buffer.subarray(44))).equals(wav.subarray(44))
    ).toBe(true);
  });

  it("pads speech, merges overlaps and grows a blip to 1 s without touching a neighbour", () => {
    const wav = makeWav(60);
    const pieces = planSpeechPieces(wav, [at(10, 10.2), at(10.3, 10.4), at(41, 50)], {
      maxSeconds: 30,
      padSeconds: 0.25,
    });

    // The overlapping blips merge to 9.75-10.65 s, too far from 41 s to join it,
    // and that 0.9 s piece grows to the 1 s Whisper needs.
    expect(pieces).toHaveLength(2);
    expect(pieces[0].offsetSeconds).toBeCloseTo(9.75, 3);
    expect(pieces[0].durationSeconds).toBeCloseTo(1, 3);

    // A blip right before a full neighbour grows backwards into the silence.
    const tight = planSpeechPieces(wav, [at(10, 10.2), at(10.6, 40.5)], {
      maxSeconds: 30,
      padSeconds: 0,
    });
    expect(tight).toHaveLength(2);
    expect(tight[0].offsetSeconds + tight[0].durationSeconds).toBeCloseTo(10.6, 3);
    expect(tight[0].durationSeconds).toBeCloseTo(1, 3);
    expect(tight[1].offsetSeconds).toBeCloseTo(10.6, 3);
  });

  it("returns null when there is nothing to plan, so the caller keeps every sample", () => {
    expect(planSpeechPieces(makeWav(10), [], {})).toBeNull();
    expect(planSpeechPieces(Buffer.from("nope"), [at(0, 1)], {})).toBeNull();
    expect(planSpeechPieces(makeWav(10), [{ start: 5, end: 5 }], {})).toBeNull();
  });
});

describe("PCM helpers", () => {
  it("round-trips a PCM16 WAV header", () => {
    const info = parseWavPcmInfo(createPcm16WavBuffer(Buffer.alloc(BYTE_RATE * 2)));
    expect(info).toMatchObject({
      audioFormat: 1,
      channels: 1,
      sampleRate: SAMPLE_RATE,
      bitsPerSample: 16,
      dataOffset: 44,
      dataSize: BYTE_RATE * 2,
      durationSeconds: 2,
    });
    expect(parseWavPcmInfo(Buffer.from("not a wav file at all, just some text bytes!!"))).toBe(
      null
    );
  });

  it("converts PCM16 to floats inside [-1, 1]", () => {
    const pcm = Buffer.alloc(8);
    pcm.writeInt16LE(32767, 0);
    pcm.writeInt16LE(-32768, 2);
    pcm.writeInt16LE(0, 4);
    pcm.writeInt16LE(16384, 6);
    expect(Array.from(pcm16ToFloat32(pcm))).toEqual([32767 / 32768, -1, 0, 0.5]);
  });
});
