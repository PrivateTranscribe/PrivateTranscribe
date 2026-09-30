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

beforeEach(() => {
  localStorageMock.clear();
  window.localStorage = localStorageMock;
  window.electronAPI = {
    processLocalReasoning: vi.fn().mockResolvedValue({ success: true, text: "" }),
    processAnthropicReasoning: vi.fn().mockResolvedValue({ success: true, text: "..." }),
  } as any;
});

describe("short dictation survives empty enhancement", () => {
  it.each(["Alice", "year", "Okay", "Thank you", "Not yet", "42", "mange tak", "東京"])(
    "preserves %s through local IPC",
    async (text) => {
      expect(
        await ReasoningService.processText(text, "qwen3-4b", null, { smartContext: null })
      ).toBe(text);
    }
  );
  it("also preserves a short fragment when Anthropic returns punctuation only", async () => {
    expect(
      await ReasoningService.processText("Not yet", "claude-haiku-4-5", null, {
        smartContext: null,
      })
    ).toBe("Not yet");
  });
  it("still accepts a useful correction", async () => {
    vi.mocked(window.electronAPI.processLocalReasoning).mockResolvedValue({
      success: true,
      text: "Thursday",
    });
    expect(
      await ReasoningService.processText("thrusday", "qwen3-4b", null, { smartContext: null })
    ).toBe("Thursday");
  });
  it("does not turn punctuation or empty input into invented words", async () => {
    expect(
      await ReasoningService.processText("...", "qwen3-4b", null, { smartContext: null })
    ).toBe("");
    expect(await ReasoningService.processText("", "qwen3-4b", null, { smartContext: null })).toBe(
      ""
    );
  });
});
