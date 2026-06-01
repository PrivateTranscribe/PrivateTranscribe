import { describe, it, expect } from "vitest";
import * as os from "os";
import * as path from "path";

// Import pure helpers from the benchmark script (CJS module)
const {
  removeRepetitions,
  normalizeWhitespace,
  findModelPath,
  generateSilentWav,
} = require("../../../scripts/benchmark-transcription");

// ── removeRepetitions ──────────────────────────────────────────────────────────

describe("removeRepetitions", () => {
  it("collapses a repeated 3-word phrase into one occurrence", () => {
    const input = "hello world foo hello world foo hello world foo";
    expect(removeRepetitions(input)).toBe("hello world foo");
  });

  it("collapses a repeated single word that appears 5+ times", () => {
    const input = "yes yes yes yes yes";
    expect(removeRepetitions(input)).toBe("yes");
  });

  it("leaves non-repeated text unchanged", () => {
    const input = "the quick brown fox jumps";
    expect(removeRepetitions(input)).toBe(input);
  });

  it("handles empty string", () => {
    expect(removeRepetitions("")).toBe("");
  });

  it("handles null/undefined gracefully", () => {
    // The function guards with `if (!text) return text`
    expect(removeRepetitions(null as unknown as string)).toBeNull();
    expect(removeRepetitions(undefined as unknown as string)).toBeUndefined();
  });
});

// ── normalizeWhitespace ────────────────────────────────────────────────────────

describe("normalizeWhitespace", () => {
  it("trims leading and trailing whitespace", () => {
    expect(normalizeWhitespace("  hello  ")).toBe("hello");
  });

  it("collapses multiple spaces into one", () => {
    expect(normalizeWhitespace("foo   bar  baz")).toBe("foo bar baz");
  });

  it("replaces newlines with spaces", () => {
    expect(normalizeWhitespace("line one\nline two")).toBe("line one line two");
  });

  it("handles already-clean text", () => {
    expect(normalizeWhitespace("clean text")).toBe("clean text");
  });

  it("removes spaces before punctuation", () => {
    expect(normalizeWhitespace("clean text ?")).toBe("clean text?");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeWhitespace("   \n  ")).toBe("");
  });
});

// ── findModelPath ──────────────────────────────────────────────────────────────

describe("findModelPath", () => {
  it("returns null when the provided dirs do not exist", () => {
    const fakeDirs = [
      path.join(os.tmpdir(), "nonexistent-bench-dir-abc123"),
      path.join(os.tmpdir(), "nonexistent-bench-dir-xyz789"),
    ];
    expect(findModelPath("turbo", fakeDirs)).toBeNull();
  });

  it("returns null for an existing but empty directory", () => {
    // os.tmpdir() exists but contains no .bin files for "turbo"
    const result = findModelPath("turbo", [path.join(os.tmpdir(), "__no_such_models__")]);
    expect(result).toBeNull();
  });
});

// ── generateSilentWav ──────────────────────────────────────────────────────────

describe("generateSilentWav", () => {
  it("produces a buffer with valid RIFF/WAVE magic bytes", () => {
    const buf = generateSilentWav(1);
    expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buf.toString("ascii", 8, 12)).toBe("WAVE");
  });

  it("has correct fmt chunk header", () => {
    const buf = generateSilentWav(1);
    expect(buf.toString("ascii", 12, 16)).toBe("fmt ");
    // PCM format = 1
    expect(buf.readUInt16LE(20)).toBe(1);
    // Mono channel
    expect(buf.readUInt16LE(22)).toBe(1);
    // 16kHz sample rate
    expect(buf.readUInt32LE(24)).toBe(16000);
    // 16-bit depth
    expect(buf.readUInt16LE(34)).toBe(16);
  });

  it("has correct data chunk header and size", () => {
    const buf = generateSilentWav(1);
    expect(buf.toString("ascii", 36, 40)).toBe("data");
    // 1s at 16kHz, 16-bit mono = 32000 bytes
    expect(buf.readUInt32LE(40)).toBe(32000);
    expect(buf.length).toBe(44 + 32000);
  });

  it("scales data size with duration", () => {
    const buf3 = generateSilentWav(3);
    // 3s × 16000 × 2 bytes = 96000 data bytes
    expect(buf3.readUInt32LE(40)).toBe(96000);
    expect(buf3.length).toBe(44 + 96000);
  });

  it("produces non-silent audio (contains non-zero PCM samples)", () => {
    const buf = generateSilentWav(1);
    const audioData = buf.slice(44);
    expect(audioData.some((b) => b !== 0)).toBe(true);
  });

  it("produces deterministic output (same bytes on every call)", () => {
    const buf1 = generateSilentWav(1);
    const buf2 = generateSilentWav(1);
    expect(buf1.equals(buf2)).toBe(true);
  });
});
