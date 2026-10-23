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

  it.each([
    ["Add the file to .gitignore today.", "Add the file to .gitignore today."],
    ["We use .NET 8 and the .tsx files.", "We use .NET 8 and the .tsx files."],
    ["Run it with !important set.", "Run it with !important set."],
  ])("keeps the space before a word that starts with punctuation: %j", (input, expected) => {
    expect(normalizeTranscriptText(input)).toBe(expected);
  });

  it("still closes up a space before a comma, an ellipsis or a closing mark", () => {
    expect(normalizePunctuationSpacing("Well , wait ... okay .")).toBe("Well, wait... okay.");
    expect(normalizePunctuationSpacing("Is it 50 % ?")).toBe("Is it 50%?");
  });

  it("keeps normal spacing between words", () => {
    expect(normalizeTranscriptText("This is already clean.")).toBe("This is already clean.");
  });
});
