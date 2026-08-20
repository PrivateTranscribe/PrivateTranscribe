import { describe, expect, it } from "vitest";
import { buildDictionaryPrompt } from "../../../src/utils/dictionaryPrompt";

describe("buildDictionaryPrompt", () => {
  it("joins terms into a bare comma-separated list", () => {
    expect(buildDictionaryPrompt(["Synty", "OpenCode"])).toBe("Synty, OpenCode");
  });

  it("returns null for an empty or missing list", () => {
    expect(buildDictionaryPrompt([])).toBeNull();
    expect(buildDictionaryPrompt(null)).toBeNull();
    expect(buildDictionaryPrompt(undefined)).toBeNull();
  });

  it("trims, drops blanks, and de-duplicates", () => {
    expect(buildDictionaryPrompt(["  Synty  ", "", "   ", "Synty", "OpenCode"])).toBe(
      "Synty, OpenCode"
    );
  });

  it("ignores non-string entries", () => {
    expect(buildDictionaryPrompt(["Synty", 42 as never, null as never, "OpenCode"])).toBe(
      "Synty, OpenCode"
    );
  });
});
