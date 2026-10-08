import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

import AudioManager, { TRANSCRIPTION_TOAST_ACTIONS } from "../../../src/helpers/audioManager";
import { TRANSCRIPTION_TOAST_BUTTONS } from "../../../src/hooks/useAudioRecording";

const PARAKEET = "parakeet-tdt-0.6b-v3";

const recording = () => new Blob(["fake-webm-bytes"], { type: "audio/webm" });

/** What ipcRenderer.invoke rejects with when the main-process handler throws. */
const ipcRejection = (message: string) =>
  new Error(`Error invoking remote method 'transcribe-local-parakeet': Error: ${message}`);

const whisperListing = (models: Array<{ model: string; size_bytes?: number }>) => ({
  success: true,
  models: models.map((entry) => ({ ...entry, downloaded: true, success: true })),
});

const whisperResult = {
  success: true,
  text: "whisper heard this",
  source: "local",
  timings: {},
  computeMode: "cuda",
};

type Api = {
  transcribeLocalParakeet: ReturnType<typeof vi.fn>;
  listWhisperModels: ReturnType<typeof vi.fn>;
};

describe("AudioManager Parakeet dictation", () => {
  let api: Api;

  beforeEach(() => {
    localStorageMock.clear();
    (globalThis as any).localStorage = localStorageMock;
    localStorageMock.setItem("useLocalWhisper", "true");
    localStorageMock.setItem("localTranscriptionProvider", "nvidia");
    localStorageMock.setItem("parakeetModel", PARAKEET);
    api = {
      transcribeLocalParakeet: vi.fn(),
      listWhisperModels: vi.fn().mockResolvedValue(whisperListing([])),
    };
    (window as any).electronAPI = api;
  });

  afterEach(() => {
    delete (window as any).electronAPI;
    vi.restoreAllMocks();
  });

  /** A manager whose Whisper, cloud and text post-processing are observable stubs. */
  const createManager = () => {
    const manager = new AudioManager();
    const whisper = vi
      .spyOn(manager, "processWithLocalWhisper")
      .mockResolvedValue({ ...whisperResult } as never);
    const openai = vi
      .spyOn(manager, "processWithOpenAIAPI")
      .mockResolvedValue({ success: true, text: "cloud text", source: "openai" } as never);
    vi.spyOn(manager, "processTranscription").mockImplementation(async (text: string) => text);
    return { manager, whisper, openai };
  };

  it("pastes Parakeet's text and reports it as a CPU transcription", async () => {
    api.transcribeLocalParakeet.mockResolvedValue({
      success: true,
      text: "hello from parakeet",
      decodeMs: 220,
    });
    const { manager, whisper, openai } = createManager();

    const outcome = await manager.runTranscription(recording(), {});

    expect(api.transcribeLocalParakeet).toHaveBeenCalledWith(expect.any(ArrayBuffer), {
      model: PARAKEET,
      allowedLanguages: expect.any(Array),
    });
    expect(outcome.result).toMatchObject({
      success: true,
      text: "hello from parakeet",
      source: "local-parakeet",
    });
    expect(outcome.result.timings.transcriptionInferenceDurationMs).toBe(220);
    expect(outcome).toMatchObject({
      localProvider: "nvidia",
      activeModel: PARAKEET,
      computeMode: "cpu",
    });
    expect(whisper).not.toHaveBeenCalled();
    expect(openai).not.toHaveBeenCalled();
  });

  it("treats noSpeech like Whisper's silence: dropped, toast, no retry", async () => {
    api.transcribeLocalParakeet.mockResolvedValue({ success: true, text: "", noSpeech: true });
    const { manager, whisper, openai } = createManager();
    const onNoAudioDetected = vi.fn();
    const onError = vi.fn();
    const onTranscriptionComplete = vi.fn();
    manager.setCallbacks({ onNoAudioDetected, onError, onTranscriptionComplete } as never);
    manager.isProcessing = true;

    await manager.processAudio(recording(), { durationSeconds: 3 });

    expect(onNoAudioDetected).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(onTranscriptionComplete).not.toHaveBeenCalled();
    expect(whisper).not.toHaveBeenCalled();
    expect(openai).not.toHaveBeenCalled();
    expect(manager.isProcessing).toBe(false);
  });

  it("returns an empty success for a silent long-session piece, as Whisper does", async () => {
    api.transcribeLocalParakeet.mockResolvedValue({ success: true, text: "", noSpeech: true });
    const { manager, whisper } = createManager();
    const onNoAudioDetected = vi.fn();
    manager.setCallbacks({ onNoAudioDetected } as never);

    const outcome = await manager.runTranscription(recording(), {
      source: "long-session",
      skipPostProcessing: true,
      chunkIndex: 2,
    });

    expect(outcome.result).toMatchObject({ success: true, text: "", source: "local-parakeet" });
    expect(onNoAudioDetected).not.toHaveBeenCalled();
    expect(whisper).not.toHaveBeenCalled();
  });

  it("retries a crashed Parakeet on the user's own Whisper model when it is downloaded", async () => {
    localStorageMock.setItem("whisperModel", "small");
    api.transcribeLocalParakeet.mockRejectedValue(
      ipcRejection("Parakeet engine exited with code 3221225477")
    );
    api.listWhisperModels.mockResolvedValue(
      whisperListing([
        { model: "base", size_bytes: 147_951_465 },
        { model: "small", size_bytes: 487_601_967 },
      ])
    );
    const { manager, whisper, openai } = createManager();
    const metadata = { durationSeconds: 4, processingGeneration: 0 };

    const outcome = await manager.runTranscription(recording(), metadata);

    expect(whisper).toHaveBeenCalledTimes(1);
    expect(whisper).toHaveBeenCalledWith(expect.any(Blob), "small", metadata);
    expect(outcome.result.text).toBe("whisper heard this");
    // Recorded as an ordinary Whisper transcription, on Whisper's own engine.
    expect(outcome).toMatchObject({
      localProvider: "whisper",
      activeModel: "small",
      computeMode: "cuda",
    });
    expect(outcome.result.source).toBe("local");
    expect(openai).not.toHaveBeenCalled();
  });

  it("falls back to the smallest downloaded Whisper model when the chosen one is missing", async () => {
    localStorageMock.setItem("whisperModel", "turbo");
    api.transcribeLocalParakeet.mockResolvedValue({
      success: false,
      error: "parakeet-timeout",
      message: "Parakeet engine timed out",
    });
    api.listWhisperModels.mockResolvedValue({
      success: true,
      models: [
        { model: "turbo", downloaded: false },
        { model: "medium", downloaded: true, size_bytes: 1_533_763_059 },
        // The speaker-turn model is smaller but is never used for dictation.
        { model: "small-en-tdrz", downloaded: true, size_bytes: 487_614_184 },
        { model: "base", downloaded: true, size_bytes: 147_951_465 },
      ],
    });
    const { manager, whisper } = createManager();

    const outcome = await manager.runTranscription(recording(), {});

    expect(whisper).toHaveBeenCalledWith(expect.any(Blob), "base", {});
    expect(outcome.activeModel).toBe("base");
  });

  it("offers Switch to Whisper when Parakeet fails and no Whisper model is installed", async () => {
    api.transcribeLocalParakeet.mockResolvedValue({
      success: false,
      error: "parakeet-host-exited",
      message: "Parakeet engine exited with code 1",
    });
    const { manager, whisper, openai } = createManager();
    const onError = vi.fn();
    manager.setCallbacks({ onError } as never);
    manager.isProcessing = true;

    await manager.processAudio(recording(), { durationSeconds: 3 });

    expect(whisper).not.toHaveBeenCalled();
    expect(openai).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({
      title: "Parakeet couldn't transcribe this",
      action: TRANSCRIPTION_TOAST_ACTIONS.SWITCH_TO_WHISPER,
    });
    expect(onError.mock.calls[0][0].description).not.toMatch(/[:—]/);
  });

  it("does not retry a dictation the user cancelled while Parakeet was working", async () => {
    localStorageMock.setItem("allowOpenAIFallback", "true");
    api.listWhisperModels.mockResolvedValue(whisperListing([{ model: "base", size_bytes: 1 }]));
    const { manager, whisper, openai } = createManager();
    const onError = vi.fn();
    manager.setCallbacks({ onError } as never);
    manager.isProcessing = true;
    api.transcribeLocalParakeet.mockImplementation(async () => {
      manager.cancelProcessing();
      throw ipcRejection("Parakeet engine was stopped while loading");
    });

    await manager.processAudio(recording(), { durationSeconds: 3 });

    expect(whisper).not.toHaveBeenCalled();
    expect(openai).not.toHaveBeenCalled();
    expect(api.listWhisperModels).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not retry an aborted Parakeet request", async () => {
    api.listWhisperModels.mockResolvedValue(whisperListing([{ model: "base", size_bytes: 1 }]));
    const aborted = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    api.transcribeLocalParakeet.mockRejectedValue(aborted);
    const { manager, whisper } = createManager();

    await expect(manager.runTranscription(recording(), {})).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(whisper).not.toHaveBeenCalled();
  });

  it("gives a missing Parakeet model its own toast and no fallback", async () => {
    localStorageMock.setItem("allowOpenAIFallback", "true");
    api.listWhisperModels.mockResolvedValue(whisperListing([{ model: "base", size_bytes: 1 }]));
    api.transcribeLocalParakeet.mockResolvedValue({
      success: false,
      error: "model_not_found",
      message: `Parakeet model "${PARAKEET}" not downloaded. Please download it from Settings.`,
    });
    const { manager, whisper, openai } = createManager();
    const onError = vi.fn();
    manager.setCallbacks({ onError } as never);
    manager.isProcessing = true;

    await manager.processAudio(recording(), { durationSeconds: 3 });

    expect(whisper).not.toHaveBeenCalled();
    expect(openai).not.toHaveBeenCalled();
    expect(onError.mock.calls[0][0]).toMatchObject({
      title: "Parakeet isn't downloaded yet",
      action: TRANSCRIPTION_TOAST_ACTIONS.OPEN_SPEECH_MODEL_SETTINGS,
    });
  });

  describe("the OpenAI fallback", () => {
    beforeEach(() => {
      api.transcribeLocalParakeet.mockRejectedValue(ipcRejection("Parakeet engine timed out"));
    });

    it("is used only when allowed and no local Whisper model exists", async () => {
      localStorageMock.setItem("allowOpenAIFallback", "true");
      const { manager, whisper, openai } = createManager();

      const outcome = await manager.runTranscription(recording(), {});

      expect(whisper).not.toHaveBeenCalled();
      expect(openai).toHaveBeenCalledTimes(1);
      expect(outcome.result.source).toBe("openai-fallback");
      expect(outcome.computeMode).toBe("cloud");
    });

    it("waits for local Whisper when a model is installed", async () => {
      localStorageMock.setItem("allowOpenAIFallback", "true");
      api.listWhisperModels.mockResolvedValue(whisperListing([{ model: "base", size_bytes: 1 }]));
      const { manager, whisper, openai } = createManager();

      const outcome = await manager.runTranscription(recording(), {});

      expect(whisper).toHaveBeenCalledTimes(1);
      // Whisper's own failure path decides on the cloud; Parakeet's never reaches it.
      expect(openai).not.toHaveBeenCalled();
      expect(outcome.result.text).toBe("whisper heard this");
    });

    it("is never used when the user has not allowed it", async () => {
      const { manager, openai } = createManager();

      await expect(manager.runTranscription(recording(), {})).rejects.toMatchObject({
        toast: { action: TRANSCRIPTION_TOAST_ACTIONS.SWITCH_TO_WHISPER },
      });
      expect(openai).not.toHaveBeenCalled();
    });

    it("keeps the Switch to Whisper toast when the cloud also fails", async () => {
      localStorageMock.setItem("allowOpenAIFallback", "true");
      const { manager, openai } = createManager();
      openai.mockRejectedValue(new Error("network down"));

      await expect(manager.runTranscription(recording(), {})).rejects.toMatchObject({
        message: expect.stringContaining("OpenAI fallback also failed: network down"),
        toast: { action: TRANSCRIPTION_TOAST_ACTIONS.SWITCH_TO_WHISPER },
      });
    });
  });

  it("names both failures when the Whisper retry fails too", async () => {
    api.transcribeLocalParakeet.mockRejectedValue(ipcRejection("Parakeet engine timed out"));
    api.listWhisperModels.mockResolvedValue(whisperListing([{ model: "base", size_bytes: 1 }]));
    const { manager, whisper } = createManager();
    whisper.mockRejectedValue(new Error("Local Whisper failed: server crashed"));

    await expect(manager.runTranscription(recording(), {})).rejects.toThrow(
      "Parakeet failed: Parakeet engine timed out. Local Whisper also failed: Local Whisper failed: server crashed"
    );
  });

  it("routes long-session pieces to Parakeet and retries a failed piece on Whisper", async () => {
    api.transcribeLocalParakeet
      .mockResolvedValueOnce({ success: true, text: "first piece" })
      .mockRejectedValueOnce(ipcRejection("Parakeet engine exited with code 1"));
    api.listWhisperModels.mockResolvedValue(whisperListing([{ model: "base", size_bytes: 1 }]));
    const { manager, whisper } = createManager();
    const pieceMetadata = (chunkIndex: number) => ({
      source: "long-session",
      skipPostProcessing: true,
      skipOptimization: true,
      chunkIndex,
    });

    const first = await manager.runTranscription(recording(), pieceMetadata(0));
    const second = await manager.runTranscription(recording(), pieceMetadata(1));

    expect(first.result).toMatchObject({ text: "first piece", source: "local-parakeet" });
    expect(first.computeMode).toBe("cpu");
    expect(whisper).toHaveBeenCalledTimes(1);
    expect(whisper).toHaveBeenCalledWith(expect.any(Blob), "base", pieceMetadata(1));
    expect(second).toMatchObject({ localProvider: "whisper", activeModel: "base" });
  });

  it("does not retry a long-session piece after the session was cancelled", async () => {
    api.transcribeLocalParakeet.mockRejectedValue(ipcRejection("Parakeet engine timed out"));
    api.listWhisperModels.mockResolvedValue(whisperListing([{ model: "base", size_bytes: 1 }]));
    const { manager, whisper } = createManager();
    manager.longSession.cancelled = true;

    await expect(
      manager.runTranscription(recording(), { source: "long-session", chunkIndex: 0 })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(whisper).not.toHaveBeenCalled();
  });
});

describe("Parakeet toast buttons", () => {
  let openControlPanel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorageMock.clear();
    (globalThis as any).localStorage = localStorageMock;
    openControlPanel = vi.fn().mockResolvedValue(undefined);
    (window as any).electronAPI = { openControlPanel };
  });

  afterEach(() => {
    delete (window as any).electronAPI;
  });

  it("Switch to Whisper changes the engine and opens the Dictation page", () => {
    localStorageMock.setItem("localTranscriptionProvider", "nvidia");
    // The unit-test window is a plain object, so the event dispatch is stubbed.
    const dispatchEvent = vi.fn();
    (window as any).dispatchEvent = dispatchEvent;

    const button = TRANSCRIPTION_TOAST_BUTTONS[TRANSCRIPTION_TOAST_ACTIONS.SWITCH_TO_WHISPER];
    button.onClick();
    delete (window as any).dispatchEvent;

    expect(button.label).toBe("Switch to Whisper");
    expect(localStorageMock.getItem("localTranscriptionProvider")).toBe("whisper");
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchEvent.mock.calls[0][0]).toMatchObject({
      type: "privatetranscribe-local-storage-change",
      detail: { key: "localTranscriptionProvider", value: "whisper" },
    });
    expect(openControlPanel).toHaveBeenCalledWith({ page: "dictation" });
  });

  it("the missing-model button opens the Dictation page without changing the engine", () => {
    localStorageMock.setItem("localTranscriptionProvider", "nvidia");

    TRANSCRIPTION_TOAST_BUTTONS[TRANSCRIPTION_TOAST_ACTIONS.OPEN_SPEECH_MODEL_SETTINGS].onClick();

    expect(localStorageMock.getItem("localTranscriptionProvider")).toBe("nvidia");
    expect(openControlPanel).toHaveBeenCalledWith({ page: "dictation" });
  });
});
