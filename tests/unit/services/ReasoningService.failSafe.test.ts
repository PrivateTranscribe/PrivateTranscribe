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

  it("keeps llama-server's own 5-minute inference limit for a local model", async () => {
    vi.mocked(window.electronAPI.processLocalReasoning).mockResolvedValue({
      success: true,
      text: "Local.",
    });

    await ReasoningService.processText(DICTATION, "qwen3-4b-q4_k_m");

    const forwarded = vi.mocked(window.electronAPI.processLocalReasoning).mock.calls[0][3];
    expect(forwarded.timeoutMs).toBe(300_000);
  });

  it("waits for llama-server to start on top of a caller's 30 s", async () => {
    vi.useFakeTimers();
    let answer: (value: unknown) => void = () => {};
    vi.mocked(window.electronAPI.processLocalReasoning).mockReturnValue(
      new Promise((resolve) => (answer = resolve))
    );

    const cleanup = ReasoningService.processText(DICTATION, "qwen3-4b-q4_k_m", null, {
      timeoutMs: 30_000,
    });
    // A cold start plus inference, still inside 30 s + the 60 s start allowance.
    await vi.advanceTimersByTimeAsync(85_000);
    answer({ success: true, text: "Local." });

    await expect(cleanup).resolves.toBe("Local.");
  });

  it("gives a custom endpoint time for a model on the user's PC", async () => {
    vi.useFakeTimers();
    localStorageMock.setItem("reasoningProvider", "custom");
    localStorageMock.setItem("cloudReasoningBaseUrl", "http://localhost:11434/v1");
    global.fetch = stalledFetch() as any;

    const stalled = ReasoningService.processText(DICTATION, "qwen3:8b");
    let settled = false;
    stalled.catch(() => (settled = true));
    await vi.advanceTimersByTimeAsync(60_000 + DICTATION.length * 100 - 1_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(stalled).rejects.toThrow(/timed out/);
  });

  it("gives a long session's whole transcript up to 10 minutes", async () => {
    vi.mocked(window.electronAPI.processAnthropicReasoning).mockResolvedValue({
      success: true,
      text: "Cleaned.",
    });
    const session = "and then we went over the next item on the list ".repeat(560);

    await ReasoningService.processText(session, "claude-sonnet-4-5");
    await ReasoningService.processText(session, "claude-sonnet-4-5", null, { longSession: true });

    const calls = vi.mocked(window.electronAPI.processAnthropicReasoning).mock.calls;
    expect(calls[0][3].timeoutMs).toBe(120_000);
    expect(calls[1][3].timeoutMs).toBe(20_000 + session.length * 20);
    expect(calls[1][3].timeoutMs).toBeGreaterThan(500_000);
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

describe("a cleanup cut off at its length limit", () => {
  const LONG_DICTATION = "and then we talked about the plan for next week ".repeat(200);

  function sentBody(): any {
    const [, request] = vi.mocked(global.fetch).mock.calls[0] as [string, RequestInit];
    return JSON.parse(String(request.body));
  }

  it("sizes the Groq limit to the transcript", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        okJson({ choices: [{ message: { content: "Done." }, finish_reason: "stop" }] })
      ) as any;

    await ReasoningService.processText(DICTATION, "openai/gpt-oss-20b");
    expect(sentBody().max_tokens).toBe(4096);

    // About 4,000 characters still asks for no more than the old 4,096.
    vi.mocked(global.fetch).mockClear();
    await ReasoningService.processText("x".repeat(4000), "openai/gpt-oss-20b");
    expect(sentBody().max_tokens).toBe(4096);

    vi.mocked(global.fetch).mockClear();
    await ReasoningService.processText(LONG_DICTATION, "openai/gpt-oss-20b");
    expect(sentBody().max_tokens).toBe(Math.ceil(LONG_DICTATION.length / 2) + 2048);
  });

  it("never asks Groq for more than its smallest model allows", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        okJson({ choices: [{ message: { content: "Done." }, finish_reason: "stop" }] })
      ) as any;

    await ReasoningService.processText("word ".repeat(12_000), "qwen/qwen3.8-27b");

    expect(sentBody().max_tokens).toBe(16384);
  });

  it.each([
    [
      "Groq",
      "openai/gpt-oss-20b",
      { choices: [{ message: { content: "and then we" }, finish_reason: "length" }] },
    ],
    [
      "OpenAI Responses",
      "gpt-5.6-luna",
      {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [{ type: "message", content: [{ type: "output_text", text: "and then we" }] }],
      },
    ],
    [
      "Gemini",
      "gemini-3.8-flash",
      {
        candidates: [{ content: { parts: [{ text: "and then we" }] }, finishReason: "MAX_TOKENS" }],
      },
    ],
  ])("refuses %s's partial text", async (_name, model, payload) => {
    global.fetch = vi.fn().mockResolvedValue(okJson(payload)) as any;

    await expect(ReasoningService.processText(LONG_DICTATION, model)).rejects.toThrow(
      "cut off at its length limit"
    );
  });

  it("refuses partial text from an OpenAI-compatible chat endpoint", async () => {
    localStorageMock.setItem("reasoningProvider", "custom");
    localStorageMock.setItem(
      "cloudReasoningBaseUrl",
      "https://llm.example.test/v1/chat/completions"
    );
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        okJson({ choices: [{ message: { content: "and then we" }, finish_reason: "length" }] })
      ) as any;

    await expect(ReasoningService.processText(LONG_DICTATION, "my-model")).rejects.toThrow(
      "cut off at its length limit"
    );
  });
});
