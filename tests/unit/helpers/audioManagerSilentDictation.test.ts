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
  isSmartContextEnabled: vi.fn(() => false),
  isFileIdentifiersEnabled: vi.fn(() => false),
  buildWhisperContextHint: vi.fn(),
  buildFileIdentifierHint: vi.fn(),
}));

import AudioManager from "../../../src/helpers/audioManager";

const silentBlob = () => new Blob(["x"], { type: "audio/webm" });

const speechLevel = (over: Record<string, unknown> = {}) => ({
  measured: true,
  speechDetected: false,
  readings: 60,
  peakRms: 0.004,
  floorRms: 0.003,
  loudFrames: 0,
  ...over,
});

describe("AudioManager silent dictation gate", () => {
  beforeEach(() => {
    localStorageMock.clear();
    (globalThis as any).localStorage = localStorageMock;
    (window as any).electronAPI = {};
  });

  it("skips transcription entirely when the microphone heard no speech", async () => {
    const manager = new AudioManager();
    const runTranscription = vi.spyOn(manager, "runTranscription");
    const onError = vi.fn();
    const onTranscriptionComplete = vi.fn();
    manager.setCallbacks({ onError, onTranscriptionComplete });
    manager.isProcessing = true;

    await manager.processAudio(silentBlob(), { durationSeconds: 2, speechLevel: speechLevel() });

    expect(runTranscription).not.toHaveBeenCalled();
    // A hotkey pressed with nothing spoken is not an error, so nothing is shown.
    expect(onError).not.toHaveBeenCalled();
    expect(onTranscriptionComplete).not.toHaveBeenCalled();
    expect(manager.isProcessing).toBe(false);
  });

  it("transcribes when speech was heard", async () => {
    const manager = new AudioManager();
    const runTranscription = vi.spyOn(manager, "runTranscription").mockResolvedValue({
      result: { text: "hello" },
      useLocalWhisper: true,
      localProvider: "whisper",
      activeModel: "base",
      computeMode: "cpu",
    } as never);
    manager.setCallbacks({ onTranscriptionComplete: vi.fn() });

    await manager.processAudio(silentBlob(), {
      durationSeconds: 2,
      speechLevel: speechLevel({ speechDetected: true, loudFrames: 12, peakRms: 0.3 }),
    });

    expect(runTranscription).toHaveBeenCalledTimes(1);
  });

  it("transcribes when the microphone level could not be measured", async () => {
    const manager = new AudioManager();
    const runTranscription = vi.spyOn(manager, "runTranscription").mockResolvedValue({
      result: { text: "hello" },
      useLocalWhisper: true,
      localProvider: "whisper",
      activeModel: "base",
      computeMode: "cpu",
    } as never);
    manager.setCallbacks({ onTranscriptionComplete: vi.fn() });

    await manager.processAudio(silentBlob(), {
      durationSeconds: 2,
      speechLevel: speechLevel({ measured: false, readings: 0, peakRms: 0, floorRms: 0 }),
    });

    expect(runTranscription).toHaveBeenCalledTimes(1);
  });

  it("takeSpeechLevelSummary reports unmeasured when no monitor ran", () => {
    const manager = new AudioManager();
    expect(manager.takeSpeechLevelSummary()).toMatchObject({
      measured: false,
      speechDetected: true,
    });
  });
});
