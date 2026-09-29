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

import AudioManager from "../../../src/helpers/audioManager";
import {
  __resetSharedAudioContextForTests,
  resetSharedAudioContext,
} from "../../../src/utils/sharedAudioContext";

const silentBlob = () => new Blob(["x"], { type: "audio/webm" });

const transcribed = {
  result: { text: "hello" },
  useLocalWhisper: true,
  localProvider: "whisper",
  activeModel: "base",
  computeMode: "cpu",
} as never;

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

describe("AudioManager speech gate on a meter that read exact zero", () => {
  const zeroMeter = () => speechLevel({ peakRms: 0, floorRms: 0 });

  /** Makes the recording decode to `samples` at 16 kHz, or fail to decode. */
  const decodeRecordingAs = (samples: Float32Array | Error) => {
    const decodeAudioData = vi.fn(async () => {
      if (samples instanceof Error) throw samples;
      return { numberOfChannels: 1, sampleRate: 16000, getChannelData: () => samples };
    });
    (window as any).OfflineAudioContext = class {
      decodeAudioData = decodeAudioData;
    };
    return decodeAudioData;
  };

  const recordingWithSpeech = () => {
    // One second of digital silence, then one second of speech-level sound.
    const samples = new Float32Array(32000);
    samples.fill(0.2, 16000);
    return samples;
  };

  const makeManager = () => {
    const manager = new AudioManager();
    const runTranscription = vi.spyOn(manager, "runTranscription").mockResolvedValue(transcribed);
    manager.setCallbacks({ onTranscriptionComplete: vi.fn() });
    manager.isProcessing = true;
    return { manager, runTranscription };
  };

  beforeEach(() => {
    localStorageMock.clear();
    (globalThis as any).localStorage = localStorageMock;
    (window as any).electronAPI = {};
  });

  afterEach(() => {
    delete (window as any).OfflineAudioContext;
  });

  it("transcribes speech the recording holds even though the meter heard none", async () => {
    const decode = decodeRecordingAs(recordingWithSpeech());
    const { manager, runTranscription } = makeManager();

    await manager.processAudio(silentBlob(), { durationSeconds: 2, speechLevel: zeroMeter() });

    expect(decode).toHaveBeenCalledTimes(1);
    expect(runTranscription).toHaveBeenCalledTimes(1);
  });

  it("still drops a recording that is digital silence as well", async () => {
    decodeRecordingAs(new Float32Array(32000));
    const { manager, runTranscription } = makeManager();

    await manager.processAudio(silentBlob(), { durationSeconds: 2, speechLevel: zeroMeter() });

    expect(runTranscription).not.toHaveBeenCalled();
    expect(manager.isProcessing).toBe(false);
  });

  it("transcribes when the recording cannot be decoded", async () => {
    decodeRecordingAs(new Error("Unable to decode audio data"));
    const { manager, runTranscription } = makeManager();

    await manager.processAudio(silentBlob(), { durationSeconds: 2, speechLevel: zeroMeter() });

    expect(runTranscription).toHaveBeenCalledTimes(1);
  });

  it("takes a meter that heard room tone at its word", async () => {
    const decode = decodeRecordingAs(recordingWithSpeech());
    const { manager, runTranscription } = makeManager();

    await manager.processAudio(silentBlob(), { durationSeconds: 2, speechLevel: speechLevel() });

    expect(decode).not.toHaveBeenCalled();
    expect(runTranscription).not.toHaveBeenCalled();
  });

  it("stops if the dictation is cancelled while the recording is measured", async () => {
    decodeRecordingAs(recordingWithSpeech());
    const { manager, runTranscription } = makeManager();

    const processing = manager.processAudio(silentBlob(), {
      durationSeconds: 2,
      speechLevel: zeroMeter(),
    });
    manager.cancelProcessing();
    await processing;

    expect(runTranscription).not.toHaveBeenCalled();
  });
});

describe("AudioManager live speech level monitor", () => {
  /** Level the fake analyser reports; a constant-filled buffer has RMS === level. */
  let micLevel = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    micLevel = 0;
    localStorageMock.clear();
    (globalThis as any).localStorage = localStorageMock;
    (window as any).electronAPI = {};

    class MockAnalyserNode {
      fftSize = 1024;
      connect = vi.fn();
      disconnect = vi.fn();
      getFloatTimeDomainData(target: Float32Array) {
        target.fill(micLevel);
      }
    }
    (window as any).AudioContext = class {
      state = "running";
      createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
      createAnalyser = vi.fn(() => new MockAnalyserNode());
      resume = vi.fn(async () => {});
      close = vi.fn(async () => {
        this.state = "closed";
      });
    };
    __resetSharedAudioContextForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetSharedAudioContextForTests();
    delete (window as any).AudioContext;
  });

  it("keeps hearing the microphone after the level meter replaces the shared context", async () => {
    const manager = new AudioManager();
    manager.recordingStream = { active: true } as never;
    expect(manager.startSpeechLevelMonitor()).toBe(true);

    // Three seconds of digital silence, then the overlay meter swaps the
    // context out from under the monitor - and only then does speech start.
    await vi.advanceTimersByTimeAsync(3_000);
    resetSharedAudioContext();
    micLevel = 0.2;
    await vi.advanceTimersByTimeAsync(2_000);

    const summary = manager.takeSpeechLevelSummary();
    expect(summary).toMatchObject({ measured: true, speechDetected: true });
    expect(summary.readings).toBeGreaterThanOrEqual(95);
  });
});
