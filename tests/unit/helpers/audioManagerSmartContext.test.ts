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
      "PrivateTranscribe, Privoca. App: VS Code, Window: audioManager.js — privoca. Identifiers: processWithLocalWhisper initialPrompt"
    );
  });

  it("skips initialPrompt entirely when translateToEnglish is enabled", async () => {
    localStorageMock.setItem("translateToEnglish", "on");

    const manager = new AudioManager();
    vi.spyOn(manager, "processTranscription").mockResolvedValue("hello world");

    await manager.processWithLocalWhisper(makeBlob(), "base");

    const [, options] = (window as any).electronAPI.transcribeLocalWhisper.mock.calls[0];
    expect(options.translate).toBe(true);
    expect(options.initialPrompt).toBeUndefined();
  });

  it("starts correction hints, smart context, and audio buffer reads in parallel", async () => {
    const correctionMemory = deferred<any[]>();
    const smartContext = deferred<any>();
    const audioBuffer = deferred<ArrayBuffer>();
    const getCorrectionMemory = vi.fn(() => correctionMemory.promise);
    mockedGetContext.mockImplementation(() => smartContext.promise);

    (globalThis as any).electronAPI = { getCorrectionMemory };

    const manager: any = new AudioManager();
    manager._checkProEntitlement = () => true;
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
