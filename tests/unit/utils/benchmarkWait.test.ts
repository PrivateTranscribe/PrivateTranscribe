import { describe, expect, it } from "vitest";
import { formatOneMinuteWait } from "../../../src/utils/benchmarkWait";

describe("formatOneMinuteWait", () => {
  it.each([
    // The number Kristian's RTX 3090 actually produced on Whisper large.
    [24.4, "about 2.5 seconds"],
    // The 1-second boundary: 59x is 1.02s, 60x is exactly 1s, 61x is 0.98s.
    [59, "about a second"],
    [60, "about a second"],
    [61, "under a second"],
    [120, "under a second"],
    [1000, "under a second"],
    // A slow CPU run: minutes of audio per minute of wall clock.
    [10, "about 6.0 seconds"],
    [6, "about 10 seconds"],
    [3, "about 20 seconds"],
    [1.2, "about 50 seconds"],
    [1, "about 1.0 minutes"],
    [0.5, "about 2.0 minutes"],
  ])("turns %sx real-time into %s", (factor, expected) => {
    expect(formatOneMinuteWait(factor)).toBe(expected);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "returns an empty string for %s so the caller can drop the line",
    (factor) => {
      expect(formatOneMinuteWait(factor)).toBe("");
    }
  );
});
