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

/**
 * API keys are saved in the control panel window, and dictation cleanup runs
 * in the overlay window. Each window has its own ReasoningService. The service
 * used to keep its own copy of a key for an hour, and only the control panel's
 * copy was dropped on a save. The overlay went on sending the old key, so a
 * corrected key kept failing in dictation while the Test button passed.
 */

const DICTATION = "um so this is what I said";

function okJson(payload: unknown) {
  return { ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) } as any;
}

const sentKeys = () =>
  vi
    .mocked(global.fetch)
    .mock.calls.map(([, init]) => new Headers((init as RequestInit).headers).get("authorization"));

beforeEach(() => {
  localStorageMock.clear();
  window.localStorage = localStorageMock;
  (ReasoningService as any).openAiEndpointPreference.clear();
  (ReasoningService as any).activeRequest = null;
  window.electronAPI = {
    getOpenAIKey: vi.fn(),
    getGroqKey: vi.fn(),
    getGeminiKey: vi.fn(),
    getCustomReasoningKey: vi.fn().mockResolvedValue(""),
  } as any;
});

describe("an API key changed in another window", () => {
  it("is used by the next OpenAI cleanup", async () => {
    vi.mocked(window.electronAPI.getOpenAIKey)
      .mockResolvedValueOnce("sk-old")
      .mockResolvedValue("sk-new");
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        okJson({ output: [{ type: "message", content: [{ type: "output_text", text: "Fine." }] }] })
      ) as any;

    await ReasoningService.processText(DICTATION, "gpt-5.6-luna");
    await ReasoningService.processText(DICTATION, "gpt-5.6-luna");

    expect(sentKeys()).toEqual(["Bearer sk-old", "Bearer sk-new"]);
  });

  it("is used by the next Groq cleanup", async () => {
    vi.mocked(window.electronAPI.getGroqKey)
      .mockResolvedValueOnce("gsk-old")
      .mockResolvedValue("gsk-new");
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        okJson({ choices: [{ message: { content: "Fine." }, finish_reason: "stop" }] })
      ) as any;

    await ReasoningService.processText(DICTATION, "openai/gpt-oss-20b");
    await ReasoningService.processText(DICTATION, "openai/gpt-oss-20b");

    expect(sentKeys()).toEqual(["Bearer gsk-old", "Bearer gsk-new"]);
  });
});
