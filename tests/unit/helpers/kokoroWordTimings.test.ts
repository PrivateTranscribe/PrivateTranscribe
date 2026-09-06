import { describe, expect, it } from "vitest";
const {
  sourceWords,
  alignWordTokens,
  buildWordTimings,
} = require("../../../src/helpers/kokoroWordTimings");

describe("Kokoro word timing", () => {
  it("keeps repeated words, Unicode and whitespace at their source offsets", () => {
    expect(sourceWords("Yes,\r\n yes! café")).toEqual([
      { text: "Yes,", start: 0, end: 4 },
      { text: "yes!", start: 7, end: 11 },
      { text: "café", start: 12, end: 16 },
    ]);
  });
  it("maps contextual vowel changes without shifting the next word", () => {
    expect(
      alignWordTokens(
        [50, 83, 16, 60, 70],
        [
          [50, 71],
          [60, 70],
        ]
      )
    ).toEqual([0, 0, -1, 1, 1]);
  });
  it("distinguishes identical words by position", () => {
    expect(alignWordTokens([50, 16, 50, 16, 50], [[50], [50], [50]])).toEqual([0, -1, 1, -1, 2]);
  });
  it("uses rounded model frames and their onset correction", () => {
    const words = sourceWords("one two");
    const timings = buildWordTimings(
      words,
      [[50], [60]],
      [0, 50, 16, 60, 0],
      [7.1, 4.1, 2.1, 8.1, 3.1],
      24 / 40
    );
    expect(timings).toEqual([
      { ...words[0], startTime: 0.1, endTime: 0.2 },
      { ...words[1], startTime: 0.25, endTime: 0.45 },
    ]);
  });
  it("refuses mismatched durations, badly aligned or truncated speech", () => {
    const words = sourceWords("one two");
    expect(buildWordTimings(words, [[50], [60]], [0, 50, 16, 60, 0], [7, 4, 2, 8, 3], 10)).toEqual(
      []
    );
    expect(alignWordTokens([1, 2, 3], [[90, 91, 92]])).toBeNull();
    expect(
      buildWordTimings(words, [[50], [60]], Array(512).fill(1), Array(512).fill(1), 12.8)
    ).toEqual([]);
  });
});
