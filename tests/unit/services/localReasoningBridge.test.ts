import { afterEach, describe, expect, it, vi } from "vitest";

const localReasoningModule: any = await import("../../../src/services/localReasoningBridge");
const LocalReasoningService = localReasoningModule.default?.default || localReasoningModule.default;
const modelManager = require("../../../src/helpers/modelManagerBridge").default;
afterEach(() => vi.restoreAllMocks());

describe("local coding transcript output", () => {
  it("requests constrained edited text and unwraps only that field", async () => {
    const run = vi
      .spyOn(modelManager, "runInference")
      .mockResolvedValue(JSON.stringify({ edited_transcript: "Write a Python function." }));
    expect(
      await LocalReasoningService.processText('write a "Python" function', "test-model", null, {
        writingStyle: "coding",
        customSystemPrompt: "Keep my words.",
      })
    ).toBe("Write a Python function.");
    const [, transcript, config] = run.mock.calls[0];
    expect(transcript).toContain(JSON.stringify('write a "Python" function'));
    expect(config.systemPrompt).toContain("Keep my words.");
    expect(config.responseFormat.schema.required).toEqual(["edited_transcript"]);
  });

  it.each(['{"other":"text"}', '{"edited_transcript":42}', "not JSON", "null"])(
    "rejects invalid structured output %s",
    async (output) => {
      vi.spyOn(modelManager, "runInference").mockResolvedValue(output);
      await expect(
        LocalReasoningService.processText("keep this", "test-model", null, {
          writingStyle: "coding",
          customSystemPrompt: "Edit only.",
        })
      ).rejects.toThrow("did not return edited text");
      expect(LocalReasoningService.isProcessing).toBe(false);
    }
  );

  it("keeps clean dictation on plain text", async () => {
    const run = vi.spyOn(modelManager, "runInference").mockResolvedValue("Clean text.");
    expect(await LocalReasoningService.processText("clean text", "test-model")).toBe("Clean text.");
    expect(run.mock.calls[0][2]).not.toHaveProperty("responseFormat");
  });
});

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
