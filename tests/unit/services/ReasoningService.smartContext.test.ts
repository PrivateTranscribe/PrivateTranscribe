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

    (globalThis.window as any).localStorage = localStorageMock;
    (globalThis.window as any).electronAPI = {
      getOpenAIKey: vi.fn().mockResolvedValue("sk-test"),
      getAnthropicKey: vi.fn(),
      getGeminiKey: vi.fn(),
      getGroqKey: vi.fn(),
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
});
