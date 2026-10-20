import { describe, expect, it } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  getAnthropicMaxTokens,
  readAnthropicText,
} = require("../../../src/helpers/anthropicReasoning");

describe("Anthropic cleanup reply", () => {
  it("returns the cleaned text", () => {
    expect(readAnthropicText({ stop_reason: "end_turn", content: [{ text: " Cleaned. " }] })).toBe(
      "Cleaned."
    );
  });

  it("refuses a reply cut off at its token limit", () => {
    expect(() =>
      readAnthropicText({ stop_reason: "max_tokens", content: [{ text: "and then we" }] })
    ).toThrow("cut off at its length limit");
  });

  it("refuses an empty reply instead of pasting nothing", () => {
    expect(() => readAnthropicText({ stop_reason: "end_turn", content: [] })).toThrow("empty");
  });

  it("sizes the limit to the transcript, past the old 4,096 cap", () => {
    expect(getAnthropicMaxTokens("short", {})).toBe(100);
    expect(getAnthropicMaxTokens("x".repeat(5000), {})).toBe(10000);
    expect(getAnthropicMaxTokens("x".repeat(50000), {})).toBe(16384);
    expect(getAnthropicMaxTokens("x".repeat(5000), { maxTokens: 300 })).toBe(300);
  });
});
