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

  it("uses the fully resolved renderer prompt without appending suffixes again", () => {
    const prompt = LocalReasoningService.resolveSystemPrompt("Ada", {
      customSystemPrompt: "Resolved prompt\n\nCustom Dictionary: PrivateTranscribe",
      customDictionary: ["duplicate"],
      preferredLanguage: "da",
    });

    expect(prompt).toBe("Resolved prompt\n\nCustom Dictionary: PrivateTranscribe");
  });

  it("keeps direct IPC callers on the shared prompt builder", () => {
    const prompt = LocalReasoningService.resolveSystemPrompt("Ada", {
      promptTemplate: "Clean for {{agentName}}.",
      customDictionary: ["PrivateTranscribe"],
      dictationMode: "email",
      preferredLanguage: "da",
    });

    expect(prompt).toContain("Clean for Ada.");
    expect(prompt).toContain("PrivateTranscribe");
    expect(prompt).toContain("Current dictation mode: email.");
    expect(prompt).toContain('preferred output language is "da"');
  });

  it("forwards explicit cleanup controls while preserving normal defaults", () => {
    const bounded = LocalReasoningService.buildInferenceConfig(
      { timeoutMs: 30_000 },
      "prompt",
      512,
      8192
    );
    expect(bounded).toMatchObject({
      disableThinking: true,
      timeoutMs: 30_000,
      maxTokens: 512,
      contextSize: 8192,
    });

    const normal = LocalReasoningService.buildInferenceConfig({}, "prompt", 512, 8192);
    expect(normal.disableThinking).toBe(true);
    expect(normal).not.toHaveProperty("timeoutMs");
  });
});
