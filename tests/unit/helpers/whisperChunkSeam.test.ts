/**
 * Long recordings are decoded in chunks and the chunk texts are joined with a
 * space. A boundary that lands inside a word therefore splits that word in the
 * final transcript - the same defect a user sees as "vildt reservat" for
 * "vildtreservat", arriving from the pipeline rather than from the model.
 *
 * These tests pin where the seam goes, not how loud anything is.
 */
import { describe, expect, it } from "vitest";
import WhisperServerManager from "../../../src/helpers/whisperServer";

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const BYTE_RATE = SAMPLE_RATE * BYTES_PER_SAMPLE;

/**
 * A mono PCM16 WAV of `seconds`, loud throughout except for the quiet windows
 * given as [startSeconds, endSeconds] pairs.
 */
function makeWav(seconds: number, quietWindows: Array<[number, number]> = []): Buffer {
  const pcmBytes = Math.floor(BYTE_RATE * seconds);
  const pcm = Buffer.alloc(pcmBytes);

  for (let i = 0; i + 2 <= pcmBytes; i += 2) {
    const t = i / BYTE_RATE;
    const quiet = quietWindows.some(([from, to]) => t >= from && t < to);
    // A plain alternating waveform: loud enough to dominate the silence, and
    // deterministic so the chosen seam cannot drift between runs.
    pcm.writeInt16LE(quiet ? 0 : (i / 2) % 2 === 0 ? 12000 : -12000, i);
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcmBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(BYTE_RATE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcmBytes, 40);

  return Buffer.concat([header, pcm]);
}

describe("long-audio chunk seams", () => {
  it("cuts at a nearby pause instead of on the clock", () => {
    const manager: any = new WhisperServerManager();
    // Continuous speech except for one pause at 62s, two seconds past the
    // boundary and well inside the search window.
    const chunks = manager._splitWavIntoTranscriptionChunks(makeWav(21 * 60, [[62, 62.5]]));

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].durationSeconds).toBeGreaterThan(61.9);
    expect(chunks[0].durationSeconds).toBeLessThan(62.6);
  });

  it("keeps the next chunk starting exactly where the previous one ended", () => {
    const manager: any = new WhisperServerManager();
    const chunks = manager._splitWavIntoTranscriptionChunks(makeWav(21 * 60, [[62, 62.5]]));

    // No audio may be dropped or decoded twice at a seam, or the transcript
    // loses a word or repeats one.
    for (let i = 1; i < chunks.length; i += 1) {
      const previousEnd = chunks[i - 1].offsetSeconds + chunks[i - 1].durationSeconds;
      expect(chunks[i].offsetSeconds).toBeCloseTo(previousEnd, 5);
    }

    const total = chunks.reduce((sum: number, chunk: any) => sum + chunk.durationSeconds, 0);
    expect(total).toBeCloseTo(21 * 60, 2);
  });

  it("falls back to the clock when the audio has no pause to find", () => {
    const manager: any = new WhisperServerManager();
    const chunks = manager._splitWavIntoTranscriptionChunks(makeWav(21 * 60));

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].durationSeconds).toBeCloseTo(60, 3);
  });

  it("still decodes a file under the threshold in one pass", () => {
    const manager: any = new WhisperServerManager();

    expect(manager._splitWavIntoTranscriptionChunks(makeWav(19 * 60))).toHaveLength(1);
  });
});
