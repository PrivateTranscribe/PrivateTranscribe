import { describe, expect, it } from "vitest";

const localReasoningModule: any = await import("../../../src/services/localReasoningBridge");
const LocalReasoningService = localReasoningModule.default?.default || localReasoningModule.default;

describe("local reasoning capacity", () => {
  it("reserves enough context and output for a multi-minute dictation", () => {
    const maxTokens = LocalReasoningService.calculateMaxTokens(6000);
    const contextSize = LocalReasoningService.calculateContextSize(6000, 4454, maxTokens);

    expect(maxTokens).toBe(2512);
    expect(contextSize).toBe(8192);
  });
});
