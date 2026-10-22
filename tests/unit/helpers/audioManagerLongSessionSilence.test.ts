import { beforeEach, describe, expect, it, vi } from "vitest";
import { localStorageMock } from "../../setup";

vi.mock("../../../src/services/ReasoningService", () => ({
  default: {
    processText: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(false),
  },
}));

vi.mock("../../../src/helpers/contextPipeline", () => ({
  getContext: vi.fn(),
  isSmartContextEnabled: vi.fn(() => false),
  isFileIdentifiersEnabled: vi.fn(() => false),
  buildWhisperContextHint: vi.fn(),
  buildFileIdentifierHint: vi.fn(),
}));

vi.mock("../../../src/utils/languageCompat", () => ({
  resolveTranscriptionLanguage: vi.fn(() => null),
}));

import AudioManager from "../../../src/helpers/audioManager";

const audioBlob = { type: "audio/webm", size: 1024, arrayBuffer: async () => new ArrayBuffer(8) };
const longSessionChunk = { source: "long-session", skipPostProcessing: true };

// A long dictation is sent in segments of about a minute. A segment the
// speaker was silent through is a normal outcome and adds nothing; a segment
// that failed is retried and, if it stays failed, marked as a gap.
describe("AudioManager long-session silence on local Whisper", () => {
  let transcribeLocalWhisper: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as any).localStorage = localStorageMock;
    localStorageMock.clear();
    localStorageMock.setItem("useLocalWhisper", "true");
    transcribeLocalWhisper = vi.fn();
    (globalThis as any).window = { electronAPI: { transcribeLocalWhisper } };
  });

  it.each([
    { name: "an empty success", reply: { success: true, text: "" } },
    { name: "no audio detected", reply: { success: false, message: "No audio detected" } },
    {
      name: "an empty audio buffer",
      reply: { success: false, error: "no_audio_data", message: "No audio detected" },
    },
  ])("counts $name as a silent segment", async ({ reply }) => {
    transcribeLocalWhisper.mockResolvedValue(reply);
    const manager: any = new AudioManager();

    const result = await manager.processWithLocalWhisper(audioBlob, "base", longSessionChunk);

    expect(result).toMatchObject({ success: true, text: "" });
  });

  it.each([
    {
      name: "a failed audio conversion",
      reply: {
        success: false,
        error: "ffmpeg_error",
        message: "Audio conversion failed. The recording may be corrupted.",
      },
    },
    {
      name: "a missing Whisper binary",
      reply: {
        success: false,
        error: "whisper_not_found",
        message: "Whisper binary is missing. Please reinstall the app.",
      },
    },
    {
      name: "a missing model",
      reply: { success: false, error: "model_not_found", message: "Model base not downloaded" },
    },
  ])("fails the segment on $name instead of dropping it as silence", async ({ reply }) => {
    transcribeLocalWhisper.mockResolvedValue(reply);
    const manager: any = new AudioManager();

    await expect(
      manager.processWithLocalWhisper(audioBlob, "base", longSessionChunk)
    ).rejects.toThrow(reply.message);
  });
});

describe("AudioManager long-session silence on cloud transcription", () => {
  const cloudManager = () => {
    const manager: any = new AudioManager();
    vi.spyOn(manager, "getTranscriptionModel").mockReturnValue("gpt-transcribe");
    vi.spyOn(manager, "getAPIKey").mockResolvedValue("sk-test-key");
    vi.spyOn(manager, "getTranscriptionEndpoint").mockReturnValue(
      "https://api.openai.com/v1/audio/transcriptions"
    );
    vi.spyOn(manager, "shouldStreamTranscription").mockReturnValue(false);
    vi.spyOn(manager, "getTranscriptionSetting").mockImplementation((key, fallback) => {
      const values: Record<string, string> = {
        allowLocalFallback: "false",
        fallbackWhisperModel: "base",
        cloudTranscriptionProvider: "openai",
      };
      return values[key] ?? fallback;
    });
    return manager;
  };

  const replyWith = (body: unknown) =>
    vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );

  beforeEach(() => {
    (globalThis as any).localStorage = localStorageMock;
    localStorageMock.clear();
    (globalThis as any).window = { electronAPI: {} };
    vi.restoreAllMocks();
  });

  it("counts an empty transcript as a silent segment", async () => {
    vi.stubGlobal("fetch", replyWith({ text: "" }));
    const manager = cloudManager();

    const result = await manager.processWithOpenAIAPI(
      new Blob(["audio"], { type: "audio/webm" }),
      { ...longSessionChunk, durationSeconds: 60 }
    );

    expect(result).toMatchObject({ success: true, text: "" });
  });

  it("pays for one request per silent segment and marks no gap", async () => {
    // A silent minute used to be retried as three paid requests inline and a
    // fourth at the end, then marked "[... missing section ...]".
    const fetchMock = vi.fn().mockImplementation(async (_url: string, request: any) => {
      const blob = (request.body as FormData).get("file") as Blob;
      const text = (await blob.text()) === "quiet" ? "" : "spoken words";
      return new Response(JSON.stringify({ text }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const manager = cloudManager();
    manager.longSessionChunkRetryBackoffMs = 0;
    vi.spyOn(manager, "processTranscription").mockImplementation(async (text) => text);
    vi.spyOn(manager, "runTranscription").mockImplementation(async (blob: Blob, metadata: any) => ({
      result: await manager.processWithOpenAIAPI(blob, metadata),
      useLocalWhisper: false,
      localProvider: "whisper",
      activeModel: "gpt-transcribe",
    }));
    const state = manager.createLongSessionState();
    state.active = true;
    state.sessionId = 7;
    manager.longSession = state;

    manager.enqueueLongSessionChunk(new Blob(["spoken"], { type: "audio/webm" }), 60_000);
    manager.enqueueLongSessionChunk(new Blob(["quiet"], { type: "audio/webm" }), 60_000);
    manager.enqueueLongSessionChunk(new Blob(["spoken"], { type: "audio/webm" }), 60_000);
    await manager.waitForLongSessionQueue();
    const result = await manager.finalizeLongSessionResult(180);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.text).toBe("spoken words spoken words");
    expect(result.longSession).toMatchObject({ failedChunks: 0 });
  });

  it("still fails an empty transcript for an ordinary dictation", async () => {
    vi.stubGlobal("fetch", replyWith({ text: "" }));
    const manager = cloudManager();

    await expect(
      manager.processWithOpenAIAPI(new Blob(["audio"], { type: "audio/webm" }), {
        durationSeconds: 3,
      })
    ).rejects.toThrow("No text transcribed");
  });
});

describe("AudioManager long-session chunk options", () => {
  it("tells the main process a segment is part of a long dictation", async () => {
    // The main process keeps its "No Audio Detected" toast for whole
    // recordings, and knows a segment only by this flag.
    (globalThis as any).localStorage = localStorageMock;
    localStorageMock.clear();
    localStorageMock.setItem("useLocalWhisper", "true");
    const transcribeLocalWhisper = vi
      .fn()
      .mockResolvedValue({ success: false, message: "No audio detected" });
    (globalThis as any).window = { electronAPI: { transcribeLocalWhisper } };
    const manager: any = new AudioManager();

    await manager.processWithLocalWhisper(audioBlob, "base", longSessionChunk);

    expect(transcribeLocalWhisper.mock.calls[0][1]).toMatchObject({ longSessionChunk: true });
  });
});
