import { describe, expect, it } from "vitest";

const llamaServerModule: any = await import("../../../src/helpers/llamaServer");
const extractCompletionText =
  llamaServerModule.extractCompletionText || llamaServerModule.default?.extractCompletionText;

describe("llama-server completion integrity", () => {
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
});
