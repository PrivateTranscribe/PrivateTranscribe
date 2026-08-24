import { describe, expect, it } from "vitest";

import {
  FIRST_CHUNK_HARD_MAX_CHARS,
  FIRST_CHUNK_MIN_CHARS,
  FIRST_CHUNK_MIN_SENTENCE_CHARS,
  FIRST_CHUNK_TARGET_MAX_CHARS,
  splitFirstChunk,
} from "../../../src/helpers/readAloudFirstChunk.js";

/**
 * The chunk boundary is the one part of first-audio playback that can be
 * proved without a speaker: whatever the timing turns out to be, a seam that
 * lands mid-word or mid-number is audibly wrong, and no measurement excuses it.
 *
 * Every case here reassembles the sentence from head + tail, because the other
 * failure mode is silent: a chunker that drops or duplicates a word would still
 * produce two plausible-sounding halves.
 */

function reassemble(sentence: string) {
  const split = splitFirstChunk(sentence);
  if (!split) return null;
  return `${split.head} ${split.tail}`;
}

describe("splitFirstChunk", () => {
  it("leaves short sentences whole", () => {
    // Below the sentence floor there is nothing worth splitting: the whole
    // sentence already synthesizes about as fast as a chunk of it would.
    expect(splitFirstChunk("Press the key again and playback stops.")).toBeNull();
    expect(splitFirstChunk("Short one.")).toBeNull();
    expect(splitFirstChunk("")).toBeNull();
    expect(splitFirstChunk(null as unknown as string)).toBeNull();
  });

  it("takes the earliest word boundary at or after the minimum", () => {
    const sentence =
      "The model runs entirely on this machine, so nothing you dictate ever leaves it.";
    const split = splitFirstChunk(sentence);

    expect(split).not.toBeNull();
    expect(split!.head).toBe("The model runs entirely on");
    expect(split!.head.length).toBeGreaterThanOrEqual(FIRST_CHUNK_MIN_CHARS);
    expect(split!.head.length).toBeLessThanOrEqual(FIRST_CHUNK_TARGET_MAX_CHARS);
    expect(reassemble(sentence)).toBe(sentence);
  });

  it("prefers a punctuation boundary over an earlier plain word boundary", () => {
    // "Once the engine is warm," ends at 24 chars — under the floor — so the
    // comma that counts here is the later one, still inside the target window.
    const sentence = "It listens locally, quietly, and never uploads a single word of it.";
    const split = splitFirstChunk(sentence);

    expect(split).not.toBeNull();
    expect(split!.punctuated).toBe(true);
    expect(split!.head).toBe("It listens locally, quietly,");
    expect(split!.head.length).toBeGreaterThanOrEqual(FIRST_CHUNK_MIN_CHARS);
    expect(reassemble(sentence)).toBe(sentence);
  });

  it("never returns a head below the minimum", () => {
    // Every word boundary before 25 chars must be rejected even though several
    // exist; the first legal cut is the one after "understand".
    const sentence = "A B C D E F is not a real sentence but it is long enough to understand it well.";
    const split = splitFirstChunk(sentence);

    expect(split).not.toBeNull();
    expect(split!.head.length).toBeGreaterThanOrEqual(FIRST_CHUNK_MIN_CHARS);
    expect(reassemble(sentence)).toBe(sentence);
  });

  it("falls back past the target window when no boundary fits inside it", () => {
    // One 40-character word straddles the whole target window, so the only
    // legal cut lives in the relief range between target and hard maximum.
    const sentence = `Wow ${"z".repeat(40)} and then some more words follow here.`;
    const split = splitFirstChunk(sentence);

    expect(split).not.toBeNull();
    expect(split!.head.length).toBeGreaterThan(FIRST_CHUNK_TARGET_MAX_CHARS);
    expect(split!.head.length).toBeLessThanOrEqual(FIRST_CHUNK_HARD_MAX_CHARS);
    expect(reassemble(sentence)).toBe(sentence);
  });

  it("returns null when no boundary exists anywhere in range", () => {
    // A single unbroken token past the hard maximum: chunking it would mean
    // cutting mid-word, so the sentence is spoken whole instead.
    const sentence = `${"a".repeat(70)} tail words here`;
    expect(sentence.length).toBeGreaterThan(FIRST_CHUNK_MIN_SENTENCE_CHARS);
    expect(splitFirstChunk(sentence)).toBeNull();
  });

  it("never splits inside a spaced number", () => {
    // Danish and German write thousands as "12 000". Cutting between the groups
    // would read as two separate numbers, so the group must survive whole —
    // ending the head just after it is fine, ending it inside is not.
    const sentence = "Fakturaen lyder på 12 000 kroner plus moms og skal betales inden fredag.";
    const split = splitFirstChunk(sentence);

    expect(split).not.toBeNull();
    expect(/\d$/.test(split!.head) && /^\d/.test(split!.tail)).toBe(false);
    expect(split!.head).toContain("12 000");
    expect(reassemble(sentence)).toBe(sentence);
  });

  it("never stops right after an abbreviation", () => {
    // The sentence splitter already ran, so a "." here is an abbreviation.
    // Ending a chunk on it would sound like the end of a sentence.
    const sentence = "Mødet med dr. Hansen er flyttet til torsdag klokken fjorten præcis.";
    const split = splitFirstChunk(sentence);

    expect(split).not.toBeNull();
    expect(split!.head.endsWith(".")).toBe(false);
    expect(reassemble(sentence)).toBe(sentence);
  });

  it("never produces a head that ends mid-word", () => {
    const sentences = [
      "The model runs entirely on this machine, so nothing you dictate ever leaves it.",
      "Each sentence is synthesized on its own and queued before the previous one ends.",
      "It listens locally, quietly, and never uploads a single word of it.",
      "Fakturaen lyder på 12 000 kroner plus moms og skal betales inden fredag.",
    ];

    for (const sentence of sentences) {
      const split = splitFirstChunk(sentence);
      expect(split, sentence).not.toBeNull();
      // The character right after the head in the original must be whitespace.
      expect(sentence[split!.head.length], sentence).toMatch(/\s/);
      expect(reassemble(sentence), sentence).toBe(sentence);
    }
  });
});
