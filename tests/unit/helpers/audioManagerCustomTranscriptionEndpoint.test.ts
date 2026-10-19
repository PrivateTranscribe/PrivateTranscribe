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

import AudioManager from "../../../src/helpers/audioManager";

function useCustomAddress(address: string) {
  localStorageMock.setItem("cloudTranscriptionProvider", "custom");
  localStorageMock.setItem("cloudTranscriptionBaseUrl", address);
}

beforeEach(() => {
  (globalThis as any).localStorage = localStorageMock;
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices: null },
    writable: true,
    configurable: true,
  });
  localStorageMock.clear();
  (globalThis.window as any).electronAPI = undefined;
});

describe("custom transcription address", () => {
  it.each([
    ["http://localhost:8000/v1", "http://localhost:8000/v1/audio/transcriptions"],
    ["https://stt.example.test/v1", "https://stt.example.test/v1/audio/transcriptions"],
  ])("sends audio to %s", (address, endpoint) => {
    useCustomAddress(address);
    expect(new AudioManager().getTranscriptionEndpoint()).toBe(endpoint);
  });

  // Falling back to api.openai.com would send the recording to a provider the
  // user never chose. Transcription stops with the reason instead.
  it.each([
    ["", "has no address"],
    ["http://stt.example.test/v1", "https://"],
    ["http://192.168.1.20:8000/v1", "https://"],
    ["http://169.254.169.254/latest", "Link-local"],
    ["not a url", "full address"],
  ])("stops on the address %j instead of using OpenAI", (address, reason) => {
    useCustomAddress(address);
    const manager = new AudioManager();

    expect(() => manager.getTranscriptionEndpoint()).toThrow(reason);
    // Asking again must not return a cached OpenAI endpoint either.
    expect(() => manager.getTranscriptionEndpoint()).toThrow(reason);
  });

  it("sends no audio anywhere when the address is refused", async () => {
    useCustomAddress("http://stt.example.test/v1");
    const manager = new AudioManager();
    vi.spyOn(manager, "getTranscriptionModel").mockReturnValue("whisper-1");
    vi.spyOn(manager, "getAPIKey").mockResolvedValue("custom-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      manager.processWithOpenAIAPI(new Blob(["audio"], { type: "audio/webm" }), {
        durationSeconds: 1,
      })
    ).rejects.toThrow("https://");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the named providers on their own endpoints", () => {
    localStorageMock.setItem("cloudTranscriptionProvider", "groq");
    localStorageMock.setItem("cloudTranscriptionBaseUrl", "http://stt.example.test/v1");
    expect(new AudioManager().getTranscriptionEndpoint()).toBe(
      "https://api.groq.com/openai/v1/audio/transcriptions"
    );
  });
});
