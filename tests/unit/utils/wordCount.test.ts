import { describe, expect, it } from "vitest";

import { countWords } from "../../../src/utils/wordCount";

describe("countWords", () => {
  it("counts words without the punctuation and space around them", () => {
    expect(countWords(" Talk to Claude Code, then fix tests. ")).toBe(7);
    expect(countWords("This transcript should never be persisted by usage tracking")).toBe(9);
    expect(countWords("fix the login bug")).toBe(4);
    expect(countWords("word ".repeat(1000))).toBe(1000);
  });

  it("returns 0 for empty or non-text input", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   ")).toBe(0);
    expect(countWords(undefined as unknown as string)).toBe(0);
  });

  it("keeps a word whole across an inner apostrophe or hyphen", () => {
    expect(countWords("don't re-run it’s")).toBe(3);
  });

  it("counts letters and digits in any script", () => {
    expect(countWords("Rød grød med fløde 5 gange")).toBe(6);
  });
});
