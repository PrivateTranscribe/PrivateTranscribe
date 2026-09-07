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
import { getModelProvider } from "../../../src/models/ModelRegistry";
import codingPrompt from "../../../src/config/codingPrompt.json";

beforeEach(() => {
  localStorageMock.clear();
  window.localStorage = localStorageMock;
  window.electronAPI = {
    enhanceWithClaudeCode: vi.fn().mockResolvedValue({ ok: true, text: "Cleaned text" }),
    agentModeRewriteStatus: vi.fn().mockResolvedValue({ available: true }),
    processLocalReasoning: vi
      .fn()
      .mockResolvedValue({ success: true, text: "Coding instructions" }),
    processAnthropicReasoning: vi
      .fn()
      .mockResolvedValue({ success: true, text: "Coding instructions" }),
  } as any;
});

describe("shared enhancement connections and writing styles", () => {
  it("routes Claude Code separately from Anthropic API keys", async () => {
    expect(getModelProvider("claude-code")).toBe("claude-code");
    expect(
      await ReasoningService.processText("um hello", "claude-code", null, { smartContext: null })
    ).toBe("Cleaned text");
    expect(window.electronAPI.processAnthropicReasoning).not.toHaveBeenCalled();
    const [text, prompt] = vi.mocked(window.electronAPI.enhanceWithClaudeCode!).mock.calls[0];
    expect(text).toBe("um hello");
    expect(prompt).not.toContain(codingPrompt.systemPrompt);
  });
  it.each(["claude-code", "qwen3-4b", "claude-haiku-4-5"])(
    "uses the same coding prompt with %s",
    async (model) => {
      await ReasoningService.processText("fix the login", model, null, {
        writingStyle: "coding",
        preferredLanguage: "en",
        smartContext: null,
      });
      const prompt =
        model === "claude-code"
          ? vi.mocked(window.electronAPI.enhanceWithClaudeCode!).mock.calls[0][1]
          : (model === "qwen3-4b"
              ? vi.mocked(window.electronAPI.processLocalReasoning).mock.calls[0][3]
              : vi.mocked(window.electronAPI.processAnthropicReasoning).mock.calls[0][3]
            ).customSystemPrompt;
      expect(prompt).toContain(codingPrompt.systemPrompt);
      expect(prompt).toContain('"en"');
    }
  );
  it("uses the installed CLI availability without requiring an API key", async () => {
    window.localStorage.setItem("reasoningModel", "claude-code");
    expect(await ReasoningService.isAvailable()).toBe(true);
    vi.mocked(window.electronAPI.agentModeRewriteStatus!).mockResolvedValue({
      available: false,
      bin: null,
    });
    expect(await ReasoningService.isAvailable()).toBe(false);
  });
  it("propagates CLI failures so dictation can fall back to the original words", async () => {
    vi.mocked(window.electronAPI.enhanceWithClaudeCode!).mockResolvedValue({
      ok: false,
      message: "Sign in to Claude Code",
    });
    await expect(ReasoningService.processText("keep my words", "claude-code")).rejects.toThrow(
      "Sign in to Claude Code"
    );
  });
  it("does not let a saved cleanup prompt replace the coding instructions", async () => {
    window.localStorage.setItem("customUnifiedPrompt", JSON.stringify("Rewrite as a poem"));
    await ReasoningService.processText("fix the login", "claude-code", null, {
      writingStyle: "coding",
    });
    expect(vi.mocked(window.electronAPI.enhanceWithClaudeCode!).mock.calls[0][1]).not.toContain(
      "poem"
    );
  });
});
