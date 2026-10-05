import { describe, expect, it } from "vitest";

const llamaServerModule: any = await import("../../../src/helpers/llamaServer");
const extractCompletionText =
  llamaServerModule.extractCompletionText || llamaServerModule.default?.extractCompletionText;
const buildInferenceRequestBody =
  llamaServerModule.buildInferenceRequestBody ||
  llamaServerModule.default?.buildInferenceRequestBody;

describe("llama-server completion integrity", () => {
  it("passes a requested response schema to the engine without changing plain-text requests", () => {
    const responseFormat = { type: "json_object", schema: { type: "object" } };
    expect(buildInferenceRequestBody([], { responseFormat }).response_format).toEqual(
      responseFormat
    );
    expect(buildInferenceRequestBody([], {})).not.toHaveProperty("response_format");
  });
  it("rejects partial cleanup output stopped by the token limit", () => {
    expect(() =>
      extractCompletionText({
        choices: [
          {
            finish_reason: "length",
            message: { content: "the beginning of a cut-off transcript" },
          },
        ],
      })
    ).toThrow("before finishing");
  });

  it("returns complete cleanup output", () => {
    expect(
      extractCompletionText({
        choices: [{ finish_reason: "stop", message: { content: " complete transcript " } }],
      })
    ).toBe("complete transcript");
  });

  it("strips only a complete leading thinking block", () => {
    expect(
      extractCompletionText({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "<think>private reasoning</think>Clean transcript" },
          },
        ],
      })
    ).toBe("Clean transcript");

    expect(
      extractCompletionText({
        choices: [
          { finish_reason: "stop", message: { content: "Keep <think>this literal text</think>" } },
        ],
      })
    ).toBe("Keep <think>this literal text</think>");
  });

  it("rejects an unfinished leading thinking block", () => {
    expect(() =>
      extractCompletionText({
        choices: [
          { finish_reason: "stop", message: { content: "<think>unfinished private reasoning" } },
        ],
      })
    ).toThrow("unfinished thinking block");
  });

  it("disables thinking only when the caller requests it", () => {
    const messages = [{ role: "user", content: "Clean this" }];
    expect(buildInferenceRequestBody(messages, { disableThinking: true })).toMatchObject({
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(buildInferenceRequestBody(messages, {})).not.toHaveProperty("chat_template_kwargs");
  });
});
