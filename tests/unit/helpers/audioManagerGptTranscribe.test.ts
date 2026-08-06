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
import { getTranscriptionModels, getDefaultTranscriptionModel } from "../../../src/models/ModelRegistry";

describe("OpenAI GPT Transcribe integration", () => {
  beforeEach(() => {
    (globalThis as any).localStorage = localStorageMock;
    Object.defineProperty(globalThis, "navigator", {
      value: { mediaDevices: null },
      writable: true,
      configurable: true,
    });
    localStorageMock.clear();
    vi.restoreAllMocks();
  });

  it("lists GPT Transcribe as OpenAI's recommended default file model", () => {
    const models = getTranscriptionModels("openai");

    expect(models[0]).toMatchObject({
      id: "gpt-transcribe",
      name: "GPT Transcribe",
      recommended: true,
    });
    expect(getDefaultTranscriptionModel("openai")).toBe("gpt-transcribe");
  });

  it("accepts GPT Transcribe as an OpenAI model and streams its file response", () => {
    localStorageMock.setItem("cloudTranscriptionProvider", "openai");
    localStorageMock.setItem("cloudTranscriptionModel", "gpt-transcribe");
    const manager = new AudioManager();

    expect(manager.getTranscriptionModel()).toBe("gpt-transcribe");
    expect(manager.shouldStreamTranscription("gpt-transcribe", "openai")).toBe(true);
  });

  it("sends the new languages[] hint instead of the legacy language field", async () => {
    const manager = new AudioManager();
    vi.spyOn(manager, "getTranscriptionModel").mockReturnValue("gpt-transcribe");
    vi.spyOn(manager, "getAPIKey").mockResolvedValue("sk-test-key");
    vi.spyOn(manager, "getTranscriptionEndpoint").mockReturnValue(
      "https://api.openai.com/v1/audio/transcriptions"
    );
    vi.spyOn(manager, "shouldStreamTranscription").mockReturnValue(false);
    vi.spyOn(manager, "getTranscriptionSetting").mockImplementation((key, fallback) => {
      const values: Record<string, string> = {
        preferredLanguage: "da",
        allowLocalFallback: "false",
        fallbackWhisperModel: "base",
        cloudTranscriptionProvider: "openai",
      };
      return values[key] ?? fallback;
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "Hej verden", languages: [{ code: "da" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await manager.processWithOpenAIAPI(new Blob(["audio"], { type: "audio/webm" }), {
      durationSeconds: 1,
    });

    const request = fetchMock.mock.calls[0][1];
    const body = request.body as FormData;
    expect(body.getAll("languages[]")).toEqual(["da"]);
    expect(body.has("language")).toBe(false);
    expect(body.get("model")).toBe("gpt-transcribe");
  });

  it("parses GPT Transcribe file-stream delta and done events", async () => {
    const manager = new AudioManager();
    vi.spyOn(manager, "getTranscriptionModel").mockReturnValue("gpt-transcribe");
    vi.spyOn(manager, "getAPIKey").mockResolvedValue("sk-test-key");
    vi.spyOn(manager, "getTranscriptionEndpoint").mockReturnValue(
      "https://api.openai.com/v1/audio/transcriptions"
    );
    vi.spyOn(manager, "getTranscriptionSetting").mockImplementation((key, fallback) => {
      const values: Record<string, string> = {
        preferredLanguage: "auto",
        allowLocalFallback: "false",
        fallbackWhisperModel: "base",
        cloudTranscriptionProvider: "openai",
      };
      return values[key] ?? fallback;
    });

    const sse = [
      'data: {"type":"transcript.text.delta","delta":"Hej "}',
      'data: {"type":"transcript.text.delta","delta":"verden"}',
      'data: {"type":"transcript.text.done","text":"Hej verden","languages":[{"code":"da"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await manager.processWithOpenAIAPI(
      new Blob(["audio"], { type: "audio/webm" }),
      { durationSeconds: 1, skipPostProcessing: true }
    );

    expect(result).toMatchObject({ success: true, text: "Hej verden", source: "openai" });
    const body = fetchMock.mock.calls[0][1].body as FormData;
    expect(body.get("stream")).toBe("true");
  });
});
