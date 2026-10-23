import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const recording = () => new Blob(["fake-webm-bytes"], { type: "audio/webm" });

// With "fall back to OpenAI" on, a failed local Whisper request is sent to
// the cloud. A dictation the user cancelled is thrown away, so its audio must
// not be uploaded on the way, as the Parakeet path already makes sure.
describe("AudioManager local Whisper fallback after a cancel", () => {
  let transcribeLocalWhisper: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorageMock.clear();
    (globalThis as any).localStorage = localStorageMock;
    localStorageMock.setItem("useLocalWhisper", "true");
    localStorageMock.setItem("localTranscriptionProvider", "whisper");
    localStorageMock.setItem("whisperModel", "base");
    localStorageMock.setItem("allowOpenAIFallback", "true");
    transcribeLocalWhisper = vi.fn();
    (window as any).electronAPI = { transcribeLocalWhisper };
  });

  afterEach(() => {
    delete (window as any).electronAPI;
    vi.restoreAllMocks();
  });

  it("does not upload a cancelled dictation when local Whisper then fails", async () => {
    const manager = new AudioManager();
    const openai = vi.spyOn(manager, "processWithOpenAIAPI").mockResolvedValue({
      success: true,
      text: "cloud heard this",
      source: "openai",
    } as never);
    const onError = vi.fn();
    const onTranscriptionComplete = vi.fn();
    manager.setCallbacks({ onError, onTranscriptionComplete } as never);
    manager.isProcessing = true;
    transcribeLocalWhisper.mockImplementation(async () => {
      manager.cancelProcessing();
      return { success: false, message: "whisper-server returned status 500" };
    });

    await manager.processAudio(recording(), { durationSeconds: 3 });

    expect(transcribeLocalWhisper).toHaveBeenCalledTimes(1);
    expect(openai).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onTranscriptionComplete).not.toHaveBeenCalled();
  });

  it("does not upload a long-session piece after the session was cancelled", async () => {
    const manager = new AudioManager();
    const openai = vi.spyOn(manager, "processWithOpenAIAPI");
    manager.longSession.cancelled = true;
    transcribeLocalWhisper.mockResolvedValue({ success: false, message: "server restarting" });

    await expect(
      manager.processWithLocalWhisper(recording(), "base", {
        source: "long-session",
        skipPostProcessing: true,
        chunkIndex: 0,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(openai).not.toHaveBeenCalled();
  });

  it("still falls back to OpenAI for a dictation nobody cancelled", async () => {
    const manager = new AudioManager();
    const openai = vi.spyOn(manager, "processWithOpenAIAPI").mockResolvedValue({
      success: true,
      text: "cloud heard this",
      source: "openai",
    } as never);
    transcribeLocalWhisper.mockResolvedValue({
      success: false,
      message: "whisper-server returned status 500",
    });

    const result = await manager.processWithLocalWhisper(recording(), "base", {});

    expect(openai).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ text: "cloud heard this", source: "openai-fallback" });
  });
});
