import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localStorageMock } from "../../setup";

vi.mock("../../../src/helpers/contextPipeline", () => ({
  getContext: vi.fn(),
  extractFileContent: vi.fn(),
  isLlmContextEnhancementEnabled: () => false,
  isLlmFileContentEnabled: () => false,
  isSmartContextEnabled: vi.fn(() => false),
  isFileIdentifiersEnabled: vi.fn(() => false),
  buildWhisperContextHint: vi.fn(),
  buildFileIdentifierHint: vi.fn(),
}));
vi.mock("../../../src/utils/languageCompat", () => ({
  resolveTranscriptionLanguage: vi.fn(() => null),
}));
vi.mock("../../../src/utils/logger", () => ({
  default: {
    logReasoning: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  },
}));

import ReasoningService from "../../../src/services/ReasoningService";
import AudioManager from "../../../src/helpers/audioManager";

/**
 * The service runs one cleanup at a time. Escape during "processing" cancelled
 * the dictation but left its cleanup request running, and the request kept the
 * service's one place until the provider answered or the deadline passed. A
 * dictation made in that time was refused with "Already processing a request"
 * and pasted without cleanup.
 */

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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  localStorageMock.clear();
  window.localStorage = localStorageMock;
  (globalThis as any).localStorage = localStorageMock;
  (ReasoningService as any).openAiEndpointPreference.clear();
  (ReasoningService as any).activeRequest = null;
  (ReasoningService as any).cancelActive = null;
  window.electronAPI = {
    getOpenAIKey: vi.fn().mockResolvedValue("sk-openai"),
    getCustomReasoningKey: vi.fn().mockResolvedValue(""),
    processLocalReasoning: vi.fn(),
    cancelLocalReasoning: vi.fn().mockResolvedValue({ success: true, cancelled: true }),
  } as any;
  Object.defineProperty(globalThis, "navigator", {
    value: {
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue([]),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a dictation cancelled while its cleanup is still running", () => {
  it("frees the cleanup service for the next dictation", async () => {
    const stalled = stalledFetch();
    global.fetch = stalled as any;
    const manager: any = new AudioManager();
    manager.isProcessing = true;

    const cancelledCleanup = ReasoningService.processText(DICTATION, "gpt-5.6-luna").catch(
      (error: Error) => error
    );
    for (let i = 0; i < 20 && stalled.mock.calls.length === 0; i++) await tick();
    expect(stalled).toHaveBeenCalledOnce();

    expect(manager.cancelProcessing()).toBe(true);

    global.fetch = vi
      .fn()
      .mockResolvedValue(
        okJson({ output: [{ type: "message", content: [{ type: "output_text", text: "Fine." }] }] })
      ) as any;
    await expect(ReasoningService.processText(DICTATION, "gpt-5.6-luna")).resolves.toBe("Fine.");

    // The cancelled request was really stopped, not left to run to its end.
    expect((stalled.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
    expect(await cancelledCleanup).toBeInstanceOf(Error);
  });

  it("tells the main process to stop a local model's cleanup", async () => {
    // The main process answers a local cleanup; until it does, nothing comes back.
    vi.mocked(window.electronAPI.processLocalReasoning).mockReturnValueOnce(new Promise(() => {}));
    const manager: any = new AudioManager();
    manager.isProcessing = true;

    const cancelledCleanup = ReasoningService.processText(DICTATION, "qwen3-4b-q4_k_m").catch(
      (error: Error) => error
    );
    for (let i = 0; i < 20; i++) await tick();
    expect(window.electronAPI.processLocalReasoning).toHaveBeenCalledOnce();

    manager.cancelProcessing();

    expect(window.electronAPI.cancelLocalReasoning).toHaveBeenCalledOnce();
    expect(await cancelledCleanup).toBeInstanceOf(Error);

    vi.mocked(window.electronAPI.processLocalReasoning).mockResolvedValue({
      success: true,
      text: "Local.",
    });
    await expect(ReasoningService.processText(DICTATION, "qwen3-4b-q4_k_m")).resolves.toBe(
      "Local."
    );
  });

  it("leaves a cleanup alone when nothing is being processed", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        okJson({ output: [{ type: "message", content: [{ type: "output_text", text: "Fine." }] }] })
      ) as any;
    const manager: any = new AudioManager();

    const cleanup = ReasoningService.processText(DICTATION, "gpt-5.6-luna");
    expect(manager.cancelProcessing()).toBe(false);

    await expect(cleanup).resolves.toBe("Fine.");
  });
});
