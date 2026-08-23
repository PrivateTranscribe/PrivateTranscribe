import { describe, expect, it } from "vitest";
import { formatBenchmarkClip, formatBenchmarkWait } from "../../../src/utils/benchmarkWait";

describe("formatBenchmarkWait", () => {
  it.each([
    // The number Kristian's RTX 3090 actually produced on Whisper large.
    [410, "0.4s"],
    [190, "0.2s"],
    [1000, "1.0s"],
    [9949, "9.9s"],
    // Past ten seconds a tenth of a second is noise, so it rounds.
    [10_000, "10s"],
    [37_400, "37s"],
    [59_400, "59s"],
    // A slow CPU run on a heavy model.
    [60_000, "1m"],
    [90_000, "1m 30s"],
    [120_000, "2m"],
    [224_000, "3m 44s"],
  ])("turns %sms into %s", (elapsedMs, expected) => {
    expect(formatBenchmarkWait(elapsedMs)).toBe(expected);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "returns an empty string for %s so the caller can drop the line",
    (elapsedMs) => {
      expect(formatBenchmarkWait(elapsedMs)).toBe("");
    }
  );
});

describe("formatBenchmarkClip", () => {
  it.each([
    [10, "10 seconds of audio"],
    [10.0, "10 seconds of audio"],
    [9.6, "9.6 seconds of audio"],
    [30, "30 seconds of audio"],
  ])("describes a %ss clip as %s", (seconds, expected) => {
    expect(formatBenchmarkClip(seconds)).toBe(expected);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("is empty for %s", (seconds) => {
    expect(formatBenchmarkClip(seconds)).toBe("");
  });
});
