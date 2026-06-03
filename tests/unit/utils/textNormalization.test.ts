import { describe, expect, it } from "vitest";

const {
  normalizePunctuationSpacing,
  normalizeTranscriptText,
} = require("../../../src/utils/textNormalization");

describe("textNormalization", () => {
  it("removes spaces before terminal punctuation", () => {
    expect(normalizePunctuationSpacing("Can we test this ? Yes !")).toBe("Can we test this? Yes!");
  });

  it("repairs STT spaces inside English contractions", () => {
    expect(normalizePunctuationSpacing("I 'll test it. You 're right. It 's odd."))
      .toBe("I'll test it. You're right. It's odd.");
    expect(normalizePunctuationSpacing("I ’ m sure they ' ve seen it and don ' t mind."))
      .toBe("I’m sure they've seen it and don't mind.");
  });

  it("does not remove spaces before quoted words", () => {
    expect(normalizePunctuationSpacing("He said ' hello ' and left."))
      .toBe("He said ' hello ' and left.");
  });

  it("normalizes transcript whitespace and punctuation spacing together", () => {
    expect(normalizeTranscriptText("  Hello\n\nworld  ?  ")).toBe("Hello world?");
  });

  it("keeps normal spacing between words", () => {
    expect(normalizeTranscriptText("This is already clean.")).toBe("This is already clean.");
  });
});
