import { describe, it, expect, vi, beforeEach } from "vitest";
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

    const result = await manager.processWithLocalWhisper(makeBlob(), "base");

    expect(result.success).toBe(true);
    expect(mockedGetContext).toHaveBeenCalledWith({
      timeoutMs: 300,
      includeFileIdentifiers: true,
    });

    expect((window as any).electronAPI.transcribeLocalWhisper).toHaveBeenCalledTimes(1);
    const [, options] = (window as any).electronAPI.transcribeLocalWhisper.mock.calls[0];
    expect(options.initialPrompt).toBe(
      "Use these exact spellings when they appear: PrivateTranscribe, Privoca. App: VS Code, Window: audioManager.js — privoca. Identifiers: processWithLocalWhisper initialPrompt"
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

    await manager.processWithLocalWhisper(makeBlob(), "large");

    const [, options] = (window as any).electronAPI.transcribeLocalWhisper.mock.calls[0];
    expect(options.language).toBeUndefined();
    expect(options.translate).toBeUndefined();
    expect(options.initialPrompt).toBe(
      "Use these exact spellings when they appear: PrivateTranscribe, Privoca. App: VS Code, Window: audioManager.js — privoca. Identifiers: processWithLocalWhisper initialPrompt"
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

    const pendingResult = manager.processWithLocalWhisper(audioBlob, "base");
    await Promise.resolve();

    expect(getCorrectionMemory).toHaveBeenCalledWith(200);
    expect(mockedGetContext).toHaveBeenCalledWith({
      timeoutMs: 300,
      includeFileIdentifiers: true,
    });
    expect(audioBlob.arrayBuffer).toHaveBeenCalledTimes(1);
    expect((window as any).electronAPI.transcribeLocalWhisper).not.toHaveBeenCalled();

    correctionMemory.resolve([{ target: "PrivateTranscribe", count: 2 }]);
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
  });
});
