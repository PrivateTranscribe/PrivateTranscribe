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
  isSmartContextEnabled: vi.fn(),
  isFileIdentifiersEnabled: vi.fn(),
  buildWhisperContextHint: vi.fn(),
  buildFileIdentifierHint: vi.fn(),
}));

vi.mock("../../../src/utils/languageCompat", () => ({
  resolveTranscriptionLanguage: vi.fn(() => null),
}));

import AudioManager from "../../../src/helpers/audioManager";
import { resolveTranscriptionLanguage } from "../../../src/utils/languageCompat";
import {
  getContext,
  isSmartContextEnabled,
  isFileIdentifiersEnabled,
  buildWhisperContextHint,
  buildFileIdentifierHint,
} from "../../../src/helpers/contextPipeline";

const mockedGetContext = vi.mocked(getContext);
const mockedIsSmartContextEnabled = vi.mocked(isSmartContextEnabled);
const mockedIsFileIdentifiersEnabled = vi.mocked(isFileIdentifiersEnabled);
const mockedBuildWhisperContextHint = vi.mocked(buildWhisperContextHint);
const mockedBuildFileIdentifierHint = vi.mocked(buildFileIdentifierHint);
const mockedResolveTranscriptionLanguage = vi.mocked(resolveTranscriptionLanguage);

function makeBlob() {
  return new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("AudioManager Smart Context whisper prompt assembly", () => {
  beforeEach(() => {
    (globalThis as any).localStorage = localStorageMock;
    Object.defineProperty(globalThis, "navigator", {
      value: { mediaDevices: null },
      writable: true,
      configurable: true,
    });
    localStorageMock.clear();
    localStorageMock.setItem("customDictionary", JSON.stringify(["PrivateTranscribe", "Privoca"]));

    mockedIsSmartContextEnabled.mockReturnValue(true);
    mockedIsFileIdentifiersEnabled.mockReturnValue(true);
    mockedGetContext.mockResolvedValue({
      available: true,
      source: "ipc",
      appName: "VS Code",
      windowTitle: "audioManager.js — privoca",
      fileIdentifiers: {
        available: true,
        identifiers: ["processWithLocalWhisper", "initialPrompt"],
      },
    } as any);
    mockedBuildWhisperContextHint.mockReturnValue(
      "App: VS Code, Window: audioManager.js — privoca"
    );
    mockedBuildFileIdentifierHint.mockReturnValue(
      "Identifiers: processWithLocalWhisper initialPrompt"
    );
    mockedResolveTranscriptionLanguage.mockReturnValue(null);

    (globalThis.window as any).electronAPI = {
      getCorrectionMemory: vi.fn().mockResolvedValue([]),
      transcribeLocalWhisper: vi.fn().mockResolvedValue({
        success: true,
        text: "hello world",
      }),
    };
    (globalThis as any).electronAPI = (globalThis.window as any).electronAPI;
  });

  it("includes dictionary, smart context, and file identifier hints in local Whisper initialPrompt", async () => {
    const manager = new AudioManager();
    vi.spyOn(manager, "processTranscription").mockResolvedValue("hello world");

    const smartContextCapture = manager.startSmartContextCapture();
    const result = await manager.processWithLocalWhisper(makeBlob(), "base", {
      smartContextCapture,
    });

    expect(result.success).toBe(true);
    expect(mockedGetContext).toHaveBeenCalledWith({
      timeoutMs: 3500,
      includeFileIdentifiers: true,
    });

    expect((window as any).electronAPI.transcribeLocalWhisper).toHaveBeenCalledTimes(1);
    const [, options] = (window as any).electronAPI.transcribeLocalWhisper.mock.calls[0];
    expect(options.initialPrompt).toBe(
      "PrivateTranscribe, Privoca. App: VS Code, Window: audioManager.js — privoca. Identifiers: processWithLocalWhisper initialPrompt"
    );
  });

  it("skips initialPrompt entirely when explicit Danish-to-English translation is enabled", async () => {
    localStorageMock.setItem("preferredLanguage", "da");
    localStorageMock.setItem("translateToEnglish", "on");
    mockedResolveTranscriptionLanguage.mockReturnValue("da");

    const manager = new AudioManager();
    vi.spyOn(manager, "processTranscription").mockResolvedValue("hello world");

    await manager.processWithLocalWhisper(makeBlob(), "large");

    const [, options] = (window as any).electronAPI.transcribeLocalWhisper.mock.calls[0];
    expect(options.language).toBe("da");
    expect(options.translate).toBe(true);
    expect(options.initialPrompt).toBeUndefined();
  });

  it("ignores a stale hidden translate toggle when speech language is auto", async () => {
    localStorageMock.setItem("preferredLanguage", "auto");
    localStorageMock.setItem("translateToEnglish", "on");
    mockedResolveTranscriptionLanguage.mockReturnValue(null);

    const manager = new AudioManager();
    vi.spyOn(manager, "processTranscription").mockResolvedValue("hej verden");

    const smartContextCapture = manager.startSmartContextCapture();
    await manager.processWithLocalWhisper(makeBlob(), "large", { smartContextCapture });

    const [, options] = (window as any).electronAPI.transcribeLocalWhisper.mock.calls[0];
    expect(options.language).toBeUndefined();
    expect(options.translate).toBeUndefined();
    expect(options.initialPrompt).toBe(
      "PrivateTranscribe, Privoca. App: VS Code, Window: audioManager.js — privoca. Identifiers: processWithLocalWhisper initialPrompt"
    );
  });

  it("ignores stale translate toggle for Turbo because the UI marks it unsupported", async () => {
    localStorageMock.setItem("preferredLanguage", "da");
    localStorageMock.setItem("translateToEnglish", "on");
    mockedResolveTranscriptionLanguage.mockReturnValue("da");

    const manager = new AudioManager();
    vi.spyOn(manager, "processTranscription").mockResolvedValue("hej verden");

    await manager.processWithLocalWhisper(makeBlob(), "turbo");

    const [, options] = (window as any).electronAPI.transcribeLocalWhisper.mock.calls[0];
    expect(options.language).toBe("da");
    expect(options.translate).toBeUndefined();
  });

  it("trims trailing silence on ordinary dictations, not just long sessions", async () => {
    const manager = new AudioManager();

    await manager.processWithLocalWhisper(makeBlob(), "large", { skipPostProcessing: true });

    const [, options] = (window as any).electronAPI.transcribeLocalWhisper.mock.calls[0];
    expect(options.trimTrailingSilence).toBe(true);
    expect(options.longSessionChunk).toBeUndefined();
  });

  it("leaves uploaded files untrimmed", async () => {
    const manager = new AudioManager();

    await manager.processWithLocalWhisper(makeBlob(), "large", {
      fileMode: true,
      skipPostProcessing: true,
    });

    const [, options] = (window as any).electronAPI.transcribeLocalWhisper.mock.calls[0];
    expect(options.trimTrailingSilence).toBeUndefined();
  });

  it("treats a silent long-session chunk as empty, not as a failure", async () => {
    // A chunk holding only a pause is normal. Throwing here burns the chunk's
    // retries and makes finalizeLongSessionResult discard the whole dictation.
    const manager = new AudioManager();
    (window as any).electronAPI.transcribeLocalWhisper = vi
      .fn()
      .mockResolvedValue({ success: false, message: "No audio detected" });

    await expect(
      manager.processWithLocalWhisper(makeBlob(), "large", {
        source: "long-session",
        skipPostProcessing: true,
      })
    ).resolves.toMatchObject({ success: true, text: "" });
  });

  it("still reports no audio for an ordinary silent dictation", async () => {
    const manager = new AudioManager();
    (window as any).electronAPI.transcribeLocalWhisper = vi
      .fn()
      .mockResolvedValue({ success: false, message: "No audio detected" });

    await expect(
      manager.processWithLocalWhisper(makeBlob(), "large", { skipPostProcessing: true })
    ).rejects.toThrow("No audio detected");
  });

  it("marks live long-session chunks for conservative Whisper decoding", async () => {
    const manager = new AudioManager();

    await manager.processWithLocalWhisper(makeBlob(), "large", {
      source: "long-session",
      skipPostProcessing: true,
    });

    const [, options] = (window as any).electronAPI.transcribeLocalWhisper.mock.calls[0];
    expect(options.longSessionChunk).toBe(true);
  });

  it("starts correction hints, smart context, and audio buffer reads in parallel", async () => {
    const correctionMemory = deferred<any[]>();
    const smartContext = deferred<any>();
    const audioBuffer = deferred<ArrayBuffer>();
    const getCorrectionMemory = vi.fn(() => correctionMemory.promise);
    mockedGetContext.mockImplementation(() => smartContext.promise);

    (globalThis as any).electronAPI = { getCorrectionMemory };

    const manager: any = new AudioManager();
    manager._checkBetaFeatureAccess = (featureId: string) => featureId === "correction-memory";
    vi.spyOn(manager, "processTranscription").mockResolvedValue("hello world");

    const audioBlob = {
      type: "audio/webm",
      size: 4,
      arrayBuffer: vi.fn(() => audioBuffer.promise),
    };

    const smartContextCapture = manager.startSmartContextCapture();
    const pendingResult = manager.processWithLocalWhisper(audioBlob, "base", {
      smartContextCapture,
    });
    await Promise.resolve();

    expect(getCorrectionMemory).toHaveBeenCalledWith(200);
    expect(mockedGetContext).toHaveBeenCalledWith({
      timeoutMs: 3500,
      includeFileIdentifiers: true,
    });
    expect(audioBlob.arrayBuffer).toHaveBeenCalledTimes(1);
    expect((window as any).electronAPI.transcribeLocalWhisper).not.toHaveBeenCalled();

    correctionMemory.resolve([
      { target: "PrivateTranscribe", count: 2, confirmed: true },
      { target: "UnapprovedHint", count: 99, confirmed: false },
    ]);
    smartContext.resolve({
      available: true,
      fileIdentifiers: { available: true, identifiers: [] },
    });
    audioBuffer.resolve(new Uint8Array([1, 2, 3, 4]).buffer);

    await expect(pendingResult).resolves.toMatchObject({
      success: true,
      text: "hello world",
      source: "local",
    });
    expect((window as any).electronAPI.transcribeLocalWhisper).toHaveBeenCalledTimes(1);
    expect(manager._cachedCorrectionHints).toEqual(["PrivateTranscribe"]);
  });
});

const EDITOR_CONTEXT = {
  available: true,
  source: "ipc",
  platform: "win32",
  processName: "Code",
  windowTitle: "App.jsx - privoca - Visual Studio Code",
};

const BROWSER_CONTEXT = {
  available: true,
  source: "ipc",
  platform: "win32",
  processName: "chrome",
  windowTitle: "Inbox - Mail - Google Chrome",
};

class MockMediaRecorder {
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void | Promise<void>) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  start = vi.fn(() => {
    this.state = "recording";
  });
  stop = vi.fn(() => {
    this.state = "inactive";
  });
  requestData = vi.fn();
}

/**
 * The window read takes about 0.85 s, longer than any wait the paste can
 * afford. It starts with the recording, so every engine's cleanup gets it,
 * and each recording carries its own read to its own cleanup.
 */
describe("AudioManager Smart Context capture timing", () => {
  const makeStream = () => ({
    active: true,
    getAudioTracks: () => [
      {
        label: "Microphone",
        getSettings: () => ({ deviceId: "default", sampleRate: 48000, channelCount: 1 }),
        stop: vi.fn(),
        readyState: "live",
      },
    ],
    getTracks: () => [{ stop: vi.fn(), readyState: "live" }],
  });

  const useEngine = (engine: "whisper" | "parakeet" | "cloud") => {
    localStorageMock.setItem("useLocalWhisper", engine === "cloud" ? "false" : "true");
    localStorageMock.setItem(
      "localTranscriptionProvider",
      engine === "parakeet" ? "nvidia" : "whisper"
    );
  };

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as any).localStorage = localStorageMock;
    (globalThis as any).MediaRecorder = MockMediaRecorder;
    localStorageMock.clear();
    localStorageMock.setItem("reasoningModel", "gpt-5-mini");
    Object.defineProperty(globalThis, "navigator", {
      value: {
        mediaDevices: {
          enumerateDevices: vi.fn().mockResolvedValue([]),
          getUserMedia: vi.fn().mockResolvedValue(makeStream()),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        },
      },
      writable: true,
      configurable: true,
    });
    (globalThis.window as any).electronAPI = {
      transcribeLocalWhisper: vi.fn().mockResolvedValue({ success: true, text: "hello" }),
      transcribeLocalParakeet: vi.fn().mockResolvedValue({ success: true, text: "hello" }),
    };
    mockedGetContext.mockReset();
    mockedIsSmartContextEnabled.mockReturnValue(true);
    mockedIsFileIdentifiersEnabled.mockReturnValue(false);
    mockedBuildWhisperContextHint.mockReturnValue("");
    mockedBuildFileIdentifierHint.mockReturnValue("");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** A manager whose AI cleanup is stubbed, so a test can read the config it got. */
  function makeManager() {
    const manager: any = new AudioManager();
    manager.onError = vi.fn();
    vi.spyOn(manager, "isReasoningAvailable").mockResolvedValue(true);
    const cleanup = vi.spyOn(manager, "processWithReasoningModel").mockResolvedValue("Hello.");
    return { manager, cleanup };
  }

  /**
   * Records for two seconds and stops, as a dictation does. Resolves once the
   * recording is handed to transcription, with its processing still running.
   */
  async function dictate(manager: any) {
    await expect(manager.startRecording()).resolves.toBe(true);
    const recorder = manager.mediaRecorder;
    recorder.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
    await vi.advanceTimersByTimeAsync(2000); // the user speaks
    manager.stopRecording();
    const processing = recorder.onstop?.();
    await vi.advanceTimersByTimeAsync(250); // the recorder's final data
    return { processing };
  }

  it("starts reading the window when the recording starts", async () => {
    mockedGetContext.mockResolvedValue(EDITOR_CONTEXT as any);
    const { manager } = makeManager();

    await expect(manager.startRecording()).resolves.toBe(true);
    await Promise.resolve();

    expect(mockedGetContext).toHaveBeenCalledTimes(1);
    expect(mockedGetContext).toHaveBeenCalledWith({
      timeoutMs: 3500,
      includeFileIdentifiers: false,
    });
  });

  it.each(["parakeet", "cloud"] as const)(
    "gives %s cleanup the window read at the start, though it took 850 ms",
    async (engine) => {
      useEngine(engine);
      mockedGetContext.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(EDITOR_CONTEXT as any), 850))
      );
      const { manager, cleanup } = makeManager();
      vi.spyOn(manager, "getAPIKey").mockResolvedValue("test-key");
      vi.spyOn(manager, "getTranscriptionModel").mockReturnValue("whisper-1");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "hello" }), { status: 200 }))
      );

      const { processing } = await dictate(manager);
      await processing;

      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(cleanup.mock.calls[0][3]).toMatchObject({ smartContext: EDITOR_CONTEXT });
    }
  );

  it("waits at most 300 ms for a read that has not finished", async () => {
    useEngine("parakeet");
    mockedGetContext.mockReturnValue(new Promise(() => {}) as any);
    const { manager, cleanup } = makeManager();

    const { processing } = await dictate(manager);
    await vi.advanceTimersByTimeAsync(299);
    expect(cleanup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await processing;

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup.mock.calls[0][3]).toMatchObject({ smartContext: null });
  });

  it("keeps a cancelled dictation out of AI cleanup while the next one runs", async () => {
    // Dictation A is cancelled while local Whisper still works on it, and the
    // user starts B in another window before A's Whisper call returns.
    useEngine("whisper");
    mockedGetContext
      .mockResolvedValueOnce(EDITOR_CONTEXT as any)
      .mockResolvedValueOnce(BROWSER_CONTEXT as any);
    let finishFirst!: (value: unknown) => void;
    (window as any).electronAPI.transcribeLocalWhisper = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)))
      .mockResolvedValueOnce({ success: true, text: "second dictation" });
    const { manager, cleanup } = makeManager();

    const { processing: first } = await dictate(manager);
    expect(manager.cancelProcessing()).toBe(true);

    const { processing: second } = await dictate(manager);
    await second;
    finishFirst({ success: true, text: "first dictation" });
    await first;

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup.mock.calls[0][0]).toBe("second dictation");
    expect(cleanup.mock.calls[0][3]).toMatchObject({ smartContext: BROWSER_CONTEXT });
  });

  it("never hands one recording's window to the next", async () => {
    useEngine("parakeet");
    mockedGetContext.mockResolvedValue(EDITOR_CONTEXT as any);
    const { manager, cleanup } = makeManager();

    await (
      await dictate(manager)
    ).processing;
    mockedIsSmartContextEnabled.mockReturnValue(false);
    await (
      await dictate(manager)
    ).processing;

    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(cleanup.mock.calls[0][3]).toMatchObject({ smartContext: EDITOR_CONTEXT });
    expect(cleanup.mock.calls[1][3]).toMatchObject({ smartContext: null });
  });

  it("reads no window when Smart Context is off", async () => {
    useEngine("parakeet");
    mockedIsSmartContextEnabled.mockReturnValue(false);
    const { manager, cleanup } = makeManager();

    await (
      await dictate(manager)
    ).processing;

    expect(mockedGetContext).not.toHaveBeenCalled();
    expect(cleanup.mock.calls[0][3]).toMatchObject({ smartContext: null });
  });
});
