import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localStorageMock } from "../../setup";

vi.mock("../../../src/helpers/contextPipeline", () => ({
  getContext: vi.fn(),
  extractFileContent: vi.fn(),
  isLlmContextEnhancementEnabled: () => false,
  isLlmFileContentEnabled: () => false,
}));
vi.mock("../../../src/utils/logger", () => ({ default: { logReasoning: vi.fn() } }));
import ReasoningService from "../../../src/services/ReasoningService";

const DICTATION = "um so this is what I said";

function okJson(payload: unknown) {
  return { ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) } as any;
}

// A provider that accepts the request and never answers, until it is aborted.
function stalledFetch() {
  return vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        const abort = () =>
          reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
        if (init.signal?.aborted) abort();
        init.signal?.addEventListener("abort", abort);
      })
  );
}

beforeEach(() => {
  localStorageMock.clear();
  window.localStorage = localStorageMock;
  (ReasoningService as any).openAiEndpointPreference.clear();
  (ReasoningService as any).isProcessing = false;
  ReasoningService.clearApiKeyCache();
  window.electronAPI = {
    getOpenAIKey: vi.fn().mockResolvedValue("sk-openai"),
    getGroqKey: vi.fn().mockResolvedValue("gsk-groq"),
    getGeminiKey: vi.fn().mockResolvedValue("gemini-key"),
    getCustomReasoningKey: vi.fn().mockResolvedValue(""),
    processAnthropicReasoning: vi.fn(),
    processLocalReasoning: vi.fn(),
  } as any;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a stalled provider during dictation", () => {
  it("gives up on its own deadline, then cleans the next dictation", async () => {
    vi.useFakeTimers();
    global.fetch = stalledFetch() as any;

    const stalled = ReasoningService.processText(DICTATION, "gpt-5.6-luna");
    const outcome = expect(stalled).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(20_000 + DICTATION.length * 20 + 1_000);
    await outcome;

    vi.useRealTimers();
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        okJson({ output: [{ type: "message", content: [{ type: "output_text", text: "Fine." }] }] })
      ) as any;
    await expect(ReasoningService.processText(DICTATION, "gpt-5.6-luna")).resolves.toBe("Fine.");
  });

  it("frees the service when an IPC reply never comes", async () => {
    vi.useFakeTimers();
    vi.mocked(window.electronAPI.processAnthropicReasoning).mockReturnValue(new Promise(() => {}));

    const stalled = ReasoningService.processText(DICTATION, "claude-sonnet-4-5");
    const outcome = expect(stalled).rejects.toThrow("AI cleanup timed out");
    await vi.advanceTimersByTimeAsync(20_000 + DICTATION.length * 20 + 1_000);
    await outcome;

    const forwarded = vi.mocked(window.electronAPI.processAnthropicReasoning).mock.calls[0][3];
    expect(forwarded.timeoutMs).toBe(20_000 + DICTATION.length * 20);

    vi.mocked(window.electronAPI.processAnthropicReasoning).mockResolvedValue({
      success: true,
      text: "Cleaned.",
    });
    const next = ReasoningService.processText(DICTATION, "claude-sonnet-4-5");
    await expect(next).resolves.toBe("Cleaned.");
  });

  it("gives a local model longer, since it may have to load first", async () => {
    vi.mocked(window.electronAPI.processLocalReasoning).mockResolvedValue({
      success: true,
      text: "Local.",
    });

    await ReasoningService.processText(DICTATION, "qwen3-4b-q4_k_m");

    const forwarded = vi.mocked(window.electronAPI.processLocalReasoning).mock.calls[0][3];
    expect(forwarded.timeoutMs).toBe(60_000 + DICTATION.length * 20);
  });

  it("keeps a timeout the caller chose", async () => {
    vi.mocked(window.electronAPI.processLocalReasoning).mockResolvedValue({
      success: true,
      text: "Local.",
    });

    await ReasoningService.processText(DICTATION, "qwen3-4b-q4_k_m", null, { timeoutMs: 30_000 });

    const forwarded = vi.mocked(window.electronAPI.processLocalReasoning).mock.calls[0][3];
    expect(forwarded.timeoutMs).toBe(30_000);
  });
});

function errorResponse(status: number, message: string) {
  const body = JSON.stringify({ error: { message } });
  return {
    ok: false,
    status,
    statusText: "Error",
    text: vi.fn().mockResolvedValue(body),
    json: vi.fn().mockResolvedValue(JSON.parse(body)),
  } as any;
}

describe("a wrong API key", () => {
  it.each([
    ["Groq", "openai/gpt-oss-20b", 1],
    ["Gemini", "gemini-3.8-flash", 1],
    // The Responses endpoint, then the chat fallback, and no retry after.
    ["OpenAI", "gpt-5.6-luna", 2],
  ])("fails %s at once instead of retrying for seconds", async (_name, model, requests) => {
    global.fetch = vi.fn().mockResolvedValue(errorResponse(401, "Invalid API key")) as any;

    await expect(ReasoningService.processText(DICTATION, model)).rejects.toThrow("Invalid API key");
    expect(global.fetch).toHaveBeenCalledTimes(requests);
  });

  it("still retries a provider that is briefly down", async () => {
    vi.useFakeTimers();
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(503, "Overloaded"))
      .mockResolvedValueOnce(
        okJson({ choices: [{ message: { content: "Back." }, finish_reason: "stop" }] })
      ) as any;

    const result = ReasoningService.processText(DICTATION, "openai/gpt-oss-20b");
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toBe("Back.");
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
