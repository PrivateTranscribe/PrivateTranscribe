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

import AudioManager from "../../../src/helpers/audioManager";

const makeStream = () => ({
  active: true,
  getAudioTracks: () => [
    {
      label: "Test microphone",
      getSettings: () => ({ deviceId: "test-device", sampleRate: 48000, channelCount: 1 }),
      stop: vi.fn(),
      readyState: "live",
    },
  ],
  getTracks: () => [{ stop: vi.fn(), readyState: "live" }],
});

class MockMediaRecorder {
  static instances: MockMediaRecorder[] = [];

  state = "inactive";
  mimeType = "audio/webm";
  stream: ReturnType<typeof makeStream>;
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

  constructor(stream: ReturnType<typeof makeStream>) {
    this.stream = stream;
    MockMediaRecorder.instances.push(this);
  }
}

/** Level the fake analyser reports; a constant-filled buffer has RMS === level. */
let micLevel = 0;

const installAudioContext = () => {
  class MockAnalyserNode {
    fftSize = 1024;
    connect = vi.fn();
    disconnect = vi.fn();
    getFloatTimeDomainData(target: Float32Array) {
      target.fill(micLevel);
    }
  }

  class MockAudioContext {
    createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
    createAnalyser = vi.fn(() => new MockAnalyserNode());
    close = vi.fn(async () => {});
  }

  (window as any).AudioContext = MockAudioContext;
};

/**
 * Runs a recording past the long-session promotion threshold and returns the
 * rotating segment recorder (the one that carries the rotation timer).
 */
const startRotatingSegment = async (manager: AudioManager) => {
  await manager.startRecording();
  const mainRecorder = MockMediaRecorder.instances[0];

  await vi.advanceTimersByTimeAsync(60_000);
  mainRecorder.ondataavailable?.({ data: new Blob(["first"], { type: "audio/webm" }) });

  const promotionRecorder = MockMediaRecorder.instances[1];
  promotionRecorder.ondataavailable?.({ data: new Blob(["promoted"], { type: "audio/webm" }) });
  await promotionRecorder.onstop?.();
  await vi.advanceTimersByTimeAsync(0);

  return MockMediaRecorder.instances[2];
};

describe("AudioManager long-session segment rotation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockMediaRecorder.instances = [];
    micLevel = 0;
    localStorageMock.clear();
    (globalThis as any).localStorage = localStorageMock;
    (window as any).electronAPI = {};
    delete (window as any).AudioContext;
    delete (window as any).webkitAudioContext;
    (globalThis as any).MediaRecorder = MockMediaRecorder;
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
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as any).AudioContext;
  });

  const makeManager = () => {
    const manager = new AudioManager();
    manager.longSessionPromotionMs = 60_000;
    vi.spyOn(manager, "runTranscription").mockImplementation(async (_blob, metadata: any) => ({
      result: {
        success: true,
        text: `chunk-${metadata.chunkIndex}`,
        source: "openai",
        timings: {},
      },
      useLocalWhisper: false,
      localProvider: "whisper",
      activeModel: "gpt-transcribe",
    }));
    manager.setCallbacks({
      onStateChange: vi.fn(),
      onError: vi.fn(),
      onTranscriptionComplete: vi.fn(),
    });
    return manager;
  };

  it("holds the boundary open while speech is still running", async () => {
    installAudioContext();
    micLevel = 0.2;
    const manager = makeManager();
    const segment = await startRotatingSegment(manager);

    // Target length reached, but the speaker has not paused yet.
    await vi.advanceTimersByTimeAsync(65_000);
    expect(segment.stop).not.toHaveBeenCalled();

    micLevel = 0.001;
    await vi.advanceTimersByTimeAsync(400);
    expect(segment.stop).toHaveBeenCalled();
  });

  it("cuts mid-speech once the hard cap is reached", async () => {
    installAudioContext();
    micLevel = 0.2;
    const manager = makeManager();
    const segment = await startRotatingSegment(manager);

    await vi.advanceTimersByTimeAsync(89_000);
    expect(segment.stop).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(segment.stop).toHaveBeenCalled();
  });

  it("rotates on the wall clock when Web Audio is unavailable", async () => {
    const manager = makeManager();
    const segment = await startRotatingSegment(manager);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(segment.stop).toHaveBeenCalled();
  });
});
