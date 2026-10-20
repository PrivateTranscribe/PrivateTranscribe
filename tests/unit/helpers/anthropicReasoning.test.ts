import { describe, expect, it } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  buildAnthropicRequestBody,
  getAnthropicMaxTokens,
  readAnthropicText,
} = require("../../../src/helpers/anthropicReasoning");

function body(modelId: string, text = "um so this is what I said") {
  return buildAnthropicRequestBody({ text, modelId, systemPrompt: "Clean it.", config: {} });
}

describe("Anthropic cleanup reply", () => {
  it("returns the cleaned text", () => {
    expect(
      readAnthropicText({
        stop_reason: "end_turn",
        content: [{ type: "text", text: " Cleaned. " }],
      })
    ).toBe("Cleaned.");
  });

  it("reads past a thinking block to the text", () => {
    expect(
      readAnthropicText({
        stop_reason: "end_turn",
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "text", text: "Cleaned." },
        ],
      })
    ).toBe("Cleaned.");
  });

  it("refuses a reply cut off at its token limit", () => {
    expect(() =>
      readAnthropicText({
        stop_reason: "max_tokens",
        content: [{ type: "text", text: "and then we" }],
      })
    ).toThrow("cut off at its length limit");
  });

  it("refuses an empty reply instead of pasting nothing", () => {
    expect(() => readAnthropicText({ stop_reason: "end_turn", content: [] })).toThrow("empty");
  });
});

describe("Anthropic cleanup request", () => {
  it.each(["claude-sonnet-4-5", "claude-haiku-4-5-20251001", "claude-opus-4-5"])(
    "sends %s a temperature, as before",
    (modelId) => {
      expect(body(modelId).temperature).toBe(0.3);
      expect(body(modelId)).not.toHaveProperty("output_config");
    }
  );

  // Sonnet 5 returns a 400 for a non-default temperature and thinks by default.
  it.each(["claude-sonnet-5", "claude-opus-5", "claude-opus-4-7"])(
    "sends %s no temperature, low effort and room to think",
    (modelId) => {
      const request = body(modelId);
      expect(request).not.toHaveProperty("temperature");
      expect(request.output_config).toEqual({ effort: "low" });
      expect(request.max_tokens).toBeGreaterThanOrEqual(4096);
    }
  );

  it("keeps the old limit for short text and grows it in tokens for long text", () => {
    expect(getAnthropicMaxTokens("short", {}, "claude-sonnet-4-5")).toBe(100);
    expect(getAnthropicMaxTokens("x".repeat(1000), {}, "claude-sonnet-4-5")).toBe(2000);
    expect(getAnthropicMaxTokens("x".repeat(4000), {}, "claude-sonnet-4-5")).toBe(4096);
    expect(getAnthropicMaxTokens("x".repeat(20000), {}, "claude-sonnet-4-5")).toBe(12048);
    expect(getAnthropicMaxTokens("x".repeat(50000), {}, "claude-sonnet-4-5")).toBe(16384);
    expect(getAnthropicMaxTokens("x".repeat(5000), { maxTokens: 300 }, "claude-sonnet-4-5")).toBe(
      300
    );
  });
});
