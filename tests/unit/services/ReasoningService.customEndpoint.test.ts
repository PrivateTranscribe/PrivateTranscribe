import { beforeEach, describe, expect, it, vi } from "vitest";
import { localStorageMock } from "../../setup";

vi.mock("../../../src/helpers/contextPipeline", () => ({
  getContext: vi.fn(),
  extractFileContent: vi.fn(),
  isLlmContextEnhancementEnabled: () => false,
  isLlmFileContentEnabled: () => false,
}));
vi.mock("../../../src/utils/logger", () => ({ default: { logReasoning: vi.fn() } }));
import ReasoningService from "../../../src/services/ReasoningService";

const CUSTOM_BASE = "https://llm.example.test/v1";

function fetchedUrls(): string[] {
  return vi.mocked(global.fetch).mock.calls.map(([url]) => String(url));
}

beforeEach(() => {
  localStorageMock.clear();
  window.localStorage = localStorageMock;
  (ReasoningService as any).openAiEndpointPreference.clear();
  window.electronAPI = {
    getCustomReasoningKey: vi.fn().mockResolvedValue("custom-key"),
    getOpenAIKey: vi.fn().mockResolvedValue("sk-openai"),
    getGroqKey: vi.fn().mockResolvedValue("gsk-groq"),
    getGeminiKey: vi.fn().mockResolvedValue("gemini-key"),
    processAnthropicReasoning: vi.fn().mockResolvedValue({ success: true, text: "Anthropic" }),
    processLocalReasoning: vi.fn().mockResolvedValue({ success: true, text: "Local model" }),
  } as any;
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({
      choices: [{ message: { content: "Cleaned on my server." }, finish_reason: "stop" }],
    }),
  }) as any;
});

describe("custom cleanup endpoint", () => {
  // A server such as vLLM or Ollama lists models under names that look like
  // other providers' models. The name must not pull the text away from it.
  it.each([
    "openai/gpt-oss-20b",
    "claude-sonnet-4-5",
    "gemini-3.8-flash",
    "qwen3:8b",
    "qwen/qwen3-32b",
    "gpt-5.6-luna",
  ])("sends %s to the custom address and nowhere else", async (model) => {
    localStorageMock.setItem("reasoningProvider", "custom");
    localStorageMock.setItem("cloudReasoningBaseUrl", CUSTOM_BASE);

    const result = await ReasoningService.processText("um so clean this up", model, null, {
      maxRetries: 0,
    });

    expect(result).toBe("Cleaned on my server.");
    expect(fetchedUrls().length).toBeGreaterThan(0);
    for (const url of fetchedUrls()) {
      expect(url.startsWith(`${CUSTOM_BASE}/`)).toBe(true);
    }
    const [, request] = vi.mocked(global.fetch).mock.calls[0] as [string, RequestInit];
    expect((request.headers as Record<string, string>).Authorization).toBe("Bearer custom-key");
    expect(JSON.parse(String(request.body)).model).toBe(model);
    expect(window.electronAPI.processAnthropicReasoning).not.toHaveBeenCalled();
    expect(window.electronAPI.processLocalReasoning).not.toHaveBeenCalled();
    expect(window.electronAPI.getOpenAIKey).not.toHaveBeenCalled();
    expect(window.electronAPI.getGroqKey).not.toHaveBeenCalled();
    expect(window.electronAPI.getGeminiKey).not.toHaveBeenCalled();
  });

  it("keeps routing by model name when a named provider is selected", async () => {
    localStorageMock.setItem("reasoningProvider", "groq");
    localStorageMock.setItem("cloudReasoningBaseUrl", CUSTOM_BASE);

    await ReasoningService.processText("um so clean this up", "openai/gpt-oss-20b", null, {
      maxRetries: 0,
    });

    expect(fetchedUrls()).toEqual(["https://api.groq.com/openai/v1/chat/completions"]);
    expect(window.electronAPI.getCustomReasoningKey).not.toHaveBeenCalled();
  });
});
