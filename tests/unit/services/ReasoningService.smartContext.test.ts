import { describe, it, expect, vi, beforeEach } from "vitest";
import { localStorageMock } from "../../setup";

vi.mock("../../../src/helpers/contextPipeline", () => ({
  getContext: vi.fn(),
  extractFileContent: vi.fn(),
  isLlmContextEnhancementEnabled: vi.fn(),
  isLlmFileContentEnabled: vi.fn(),
}));

vi.mock("../../../src/utils/logger", () => ({
  default: {
    logReasoning: vi.fn(),
  },
}));

import ReasoningService from "../../../src/services/ReasoningService";
import {
  getContext,
  extractFileContent,
  isLlmContextEnhancementEnabled,
  isLlmFileContentEnabled,
} from "../../../src/helpers/contextPipeline";

const mockedGetContext = vi.mocked(getContext);
const mockedExtractFileContent = vi.mocked(extractFileContent);
const mockedIsLlmContextEnhancementEnabled = vi.mocked(isLlmContextEnhancementEnabled);
const mockedIsLlmFileContentEnabled = vi.mocked(isLlmFileContentEnabled);

function mockJsonResponse(payload: any) {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue(payload),
  } as any;
}

describe("ReasoningService Smart Context prompt assembly", () => {
  beforeEach(() => {
    localStorageMock.clear();
    localStorageMock.setItem("customDictionary", JSON.stringify(["PrivateTranscribe"]));
    (ReasoningService as any).openAiEndpointPreference.clear();

    (globalThis.window as any).localStorage = localStorageMock;
    (globalThis.window as any).electronAPI = {
      getOpenAIKey: vi.fn().mockResolvedValue("sk-test"),
      getAnthropicKey: vi.fn(),
      getGeminiKey: vi.fn(),
      getGroqKey: vi.fn(),
      getCustomReasoningKey: vi.fn().mockResolvedValue("custom-test"),
      processLocalReasoning: vi.fn(),
      processAnthropicReasoning: vi.fn(),
    };

    mockedIsLlmContextEnhancementEnabled.mockReturnValue(true);
    mockedIsLlmFileContentEnabled.mockReturnValue(true);
    mockedGetContext.mockResolvedValue({
      available: true,
      source: "ipc",
      platform: "linux",
      appName: "VS Code",
      processName: "code",
      windowTitle: "ReasoningService.ts — PrivateTranscribe",
    } as any);
    mockedExtractFileContent.mockResolvedValue({
      available: true,
      filename: "ReasoningService.ts",
      excerpt: "const smartContext = true;",
      truncated: true,
    } as any);

    global.fetch = vi.fn().mockResolvedValue(
      mockJsonResponse({
        output_text: "Cleaned output",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Cleaned output" }],
          },
        ],
        usage: { total_tokens: 42 },
      })
    ) as any;
  });

  it("uses prefetched smart context and appends file excerpt to the OpenAI user prompt", async () => {
    const result = await ReasoningService.processText("fix this sentence", "gpt-4.1-mini", null, {
      smartContext: {
        available: true,
        source: "prefetched",
        platform: "linux",
        appName: "VS Code",
        processName: "code",
        windowTitle: "ReasoningService.ts — PrivateTranscribe",
      },
    });

    expect(result).toBe("Cleaned output");
    expect(mockedGetContext).not.toHaveBeenCalled();
    expect(mockedExtractFileContent).toHaveBeenCalledWith(
      "ReasoningService.ts — PrivateTranscribe",
      "code",
      { timeoutMs: 300, maxChars: 4000 }
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, request] = (global.fetch as any).mock.calls[0];
    const body = JSON.parse(request.body);
    const userPrompt = body.input[1].content;

    expect(userPrompt).toContain("Frontmost window context (best-effort, sanitized):");
    expect(userPrompt).toContain("- Platform: linux");
    expect(userPrompt).toContain("- App: VS Code");
    expect(userPrompt).toContain("- Process: code");
    expect(userPrompt).toContain("- Window title: ReasoningService.ts — PrivateTranscribe");
    expect(userPrompt).toContain("Active file excerpt (ReasoningService.ts):");
    expect(userPrompt).toContain("const smartContext = true;");
    expect(userPrompt).toContain("[Excerpt truncated for prompt size.]");
    expect(userPrompt.trim().endsWith("fix this sentence")).toBe(true);
  });

  it("falls back to raw text when LLM context enhancement is disabled", async () => {
    mockedIsLlmContextEnhancementEnabled.mockReturnValue(false);

    await ReasoningService.processText("keep raw", "gpt-4.1-mini");

    const [, request] = (global.fetch as any).mock.calls[0];
    const body = JSON.parse(request.body);
    expect(body.input[1].content).toBe("keep raw");
    expect(mockedExtractFileContent).not.toHaveBeenCalled();
  });

  it("sends Luna with reasoning disabled on the Responses API", async () => {
    mockedIsLlmContextEnhancementEnabled.mockReturnValue(false);

    await ReasoningService.processText("clean this", "gpt-5.6-luna", null, {
      maxRetries: 0,
    });

    const [, request] = (global.fetch as any).mock.calls[0];
    const body = JSON.parse(request.body);
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("uses the Chat Completions reasoning field after endpoint fallback", async () => {
    mockedIsLlmContextEnhancementEnabled.mockReturnValue(false);
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: vi.fn().mockResolvedValue({ error: { message: "Responses unsupported" } }),
      })
      .mockResolvedValueOnce(
        mockJsonResponse({
          choices: [{ message: { content: "Cleaned output" }, finish_reason: "stop" }],
          usage: { total_tokens: 10 },
        })
      ) as any;

    await ReasoningService.processText("clean this", "gpt-5.6-luna", null, {
      maxRetries: 0,
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const [, chatRequest] = (global.fetch as any).mock.calls[1];
    const chatBody = JSON.parse(chatRequest.body);
    expect(chatBody.reasoning_effort).toBe("none");
    expect(chatBody).not.toHaveProperty("reasoning");
  });

  it("does not send registered reasoning controls to a custom endpoint", async () => {
    mockedIsLlmContextEnhancementEnabled.mockReturnValue(false);
    localStorageMock.setItem("reasoningProvider", "custom");
    localStorageMock.setItem("cloudReasoningBaseUrl", "https://example.test/v1");

    await ReasoningService.processText("clean this", "gpt-5.6-luna", null, {
      maxRetries: 0,
    });

    const [, request] = (global.fetch as any).mock.calls[0];
    const body = JSON.parse(request.body);
    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("resolves an explicit prompt template before crossing the local IPC boundary", async () => {
    mockedIsLlmContextEnhancementEnabled.mockReturnValue(false);
    const processLocalReasoning = vi.fn().mockResolvedValue({
      success: true,
      text: "Lokal oprydning",
    });
    (globalThis.window as any).electronAPI.processLocalReasoning = processLocalReasoning;

    await ReasoningService.processText("ryd op", "qwen3.8-2b-distill-q4_k_m", "Ada", {
      promptTemplate: "Clean for {{agentName}}.",
      preferredLanguage: "da",
      smartContext: null,
      timeoutMs: 30_000,
      maxRetries: 0,
    });

    const forwardedConfig = processLocalReasoning.mock.calls[0][3];
    expect(forwardedConfig.customSystemPrompt).toContain("Clean for Ada.");
    expect(forwardedConfig.customSystemPrompt).toContain("PrivateTranscribe");
    expect(forwardedConfig.customSystemPrompt).toContain('preferred output language is "da"');
    expect(forwardedConfig.timeoutMs).toBe(30_000);
    expect(forwardedConfig.maxRetries).toBe(0);
  });

  it("resolves the saved custom prompt before crossing the Anthropic IPC boundary", async () => {
    mockedIsLlmContextEnhancementEnabled.mockReturnValue(false);
    localStorageMock.setItem("customUnifiedPrompt", JSON.stringify("Saved {{agentName}} prompt."));
    const processAnthropicReasoning = vi.fn().mockResolvedValue({
      success: true,
      text: "Cleaned output",
    });
    (globalThis.window as any).electronAPI.processAnthropicReasoning = processAnthropicReasoning;

    await ReasoningService.processText("clean this", "claude-haiku-4-5", "Ada", {
      preferredLanguage: "en",
      smartContext: null,
    });

    const forwardedConfig = processAnthropicReasoning.mock.calls[0][3];
    expect(forwardedConfig.customSystemPrompt).toContain("Saved Ada prompt.");
    expect(forwardedConfig.customSystemPrompt).toContain("PrivateTranscribe");
    expect(forwardedConfig.customSystemPrompt).toContain('preferred output language is "en"');
  });

  it("adds the registered Gemini thinking level", async () => {
    mockedIsLlmContextEnhancementEnabled.mockReturnValue(false);
    (globalThis.window as any).electronAPI.getGeminiKey = vi.fn().mockResolvedValue("gemini-test");
    global.fetch = vi.fn().mockResolvedValue(
      mockJsonResponse({
        candidates: [{ content: { parts: [{ text: "Cleaned output" }] } }],
        usageMetadata: { totalTokenCount: 10 },
      })
    ) as any;

    await ReasoningService.processText("clean this", "gemini-3.5-flash-lite", null, {
      maxRetries: 0,
    });

    const [, request] = (global.fetch as any).mock.calls[0];
    const body = JSON.parse(request.body);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
  });

  it("preserves Groq's registered non-thinking control", async () => {
    mockedIsLlmContextEnhancementEnabled.mockReturnValue(false);
    (globalThis.window as any).electronAPI.getGroqKey = vi.fn().mockResolvedValue("groq-test");
    global.fetch = vi.fn().mockResolvedValue(
      mockJsonResponse({
        choices: [{ message: { content: "Cleaned output" }, finish_reason: "stop" }],
        usage: { total_tokens: 10 },
      })
    ) as any;

    await ReasoningService.processText("clean this", "qwen/qwen3.8-27b", null, {
      maxRetries: 0,
    });

    const [, request] = (global.fetch as any).mock.calls[0];
    expect(JSON.parse(request.body).reasoning_effort).toBe("none");
  });

  it("truncates provider error bodies before returning them to the UI", async () => {
    mockedIsLlmContextEnhancementEnabled.mockReturnValue(false);
    (globalThis.window as any).electronAPI.getGroqKey = vi.fn().mockResolvedValue("groq-test");
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: vi.fn().mockResolvedValue("x".repeat(2_000)),
    }) as any;

    await expect(
      ReasoningService.processText("clean this", "qwen/qwen3.8-27b", null, {
        maxRetries: 0,
      })
    ).rejects.toThrow(`${"x".repeat(500)}...`);
  });

  it("ignores a saved custom prompt whose JSON value is not a string", async () => {
    mockedIsLlmContextEnhancementEnabled.mockReturnValue(false);
    localStorageMock.setItem("customUnifiedPrompt", JSON.stringify({ prompt: "not valid" }));

    await expect(
      ReasoningService.processText("clean this", "gpt-4.1-mini", "Ada", { maxRetries: 0 })
    ).resolves.toBe("Cleaned output");

    const [, request] = (global.fetch as any).mock.calls[0];
    const body = JSON.parse(request.body);
    expect(body.input[0].content).toEqual(expect.any(String));
    expect(body.input[0].content).not.toContain("not valid");
  });
});
