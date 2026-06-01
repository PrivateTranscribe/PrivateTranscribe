import { describe, expect, it } from "vitest";

const {
  normalizePunctuationSpacing,
  normalizeTranscriptText,
} = require("../../../src/utils/textNormalization");

describe("textNormalization", () => {
  it("removes spaces before terminal punctuation", () => {
    expect(normalizePunctuationSpacing("Can we test this ? Yes !")).toBe("Can we test this? Yes!");
  });

  it("normalizes transcript whitespace and punctuation spacing together", () => {
    expect(normalizeTranscriptText("  Hello\n\nworld  ?  ")).toBe("Hello world?");
  });

  it("keeps normal spacing between words", () => {
    expect(normalizeTranscriptText("This is already clean.")).toBe("This is already clean.");
  });
});
