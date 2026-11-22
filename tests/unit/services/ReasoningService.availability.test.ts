import { beforeEach, describe, expect, it, vi } from "vitest";
import { localStorageMock } from "../../setup";

vi.mock("../../../src/utils/logger", () => ({ default: { logReasoning: vi.fn() } }));
import ReasoningService from "../../../src/services/ReasoningService";

/**
 * Cleanup counted as available when any provider had a key. A user with an
 * OpenAI key and Anthropic selected then got a failed request on every
 * dictation instead of a skip. Only the selected provider counts now.
 */
function keys(present: Partial<Record<"openai" | "anthropic" | "gemini" | "groq", string>>) {
  window.electronAPI = {
    getOpenAIKey: vi.fn().mockResolvedValue(present.openai ?? ""),
    getAnthropicKey: vi.fn().mockResolvedValue(present.anthropic ?? ""),
    getGeminiKey: vi.fn().mockResolvedValue(present.gemini ?? ""),
    getGroqKey: vi.fn().mockResolvedValue(present.groq ?? ""),
    checkLocalReasoningAvailable: vi.fn().mockResolvedValue(false),
  } as any;
}

beforeEach(() => {
  localStorageMock.clear();
  window.localStorage = localStorageMock;
});

describe("ReasoningService.isAvailable", () => {
  it("is not available when only another provider has a key", async () => {
    localStorageMock.setItem("reasoningProvider", "anthropic");
    localStorageMock.setItem("reasoningModel", "claude-sonnet-5");
    keys({ openai: "sk-openai", groq: "gsk-groq" });

    expect(await ReasoningService.isAvailable()).toBe(false);
  });

  it.each([
    ["anthropic", "claude-sonnet-5", { anthropic: "sk-ant" }],
    ["openai", "gpt-5.6-luna", { openai: "sk-openai" }],
    ["gemini", "gemini-3.8-flash", { gemini: "gem-key" }],
    ["groq", "openai/gpt-oss-20b", { groq: "gsk-groq" }],
  ])("is available with the %s key for a %s model", async (provider, model, present) => {
    localStorageMock.setItem("reasoningProvider", provider);
    localStorageMock.setItem("reasoningModel", model);
    keys(present);

    expect(await ReasoningService.isAvailable()).toBe(true);
  });

  it("asks the local model, not the cloud keys, for a local model", async () => {
    localStorageMock.setItem("reasoningProvider", "qwen");
    localStorageMock.setItem("reasoningModel", "qwen3.8-2b-distill-q4_k_m");
    keys({ openai: "sk-openai" });

    expect(await ReasoningService.isAvailable()).toBe(false);
    vi.mocked(window.electronAPI.checkLocalReasoningAvailable).mockResolvedValue(true);
    expect(await ReasoningService.isAvailable()).toBe(true);
  });
});
