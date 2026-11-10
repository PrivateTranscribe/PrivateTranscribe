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
  getTracks: () => [
    {
      stop: vi.fn(),
      readyState: "live",
    },
  ],
});

class MockMediaRecorder {
  static instances: MockMediaRecorder[] = [];

  state = "inactive";
  mimeType = "audio/webm";
  stream: ReturnType<typeof makeStream>;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void | Promise<void>) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  start = vi.fn((timeslice?: number) => {
    this.state = "recording";
    this.startTimeslice = timeslice;
  });
  stop = vi.fn(() => {
    this.state = "inactive";
  });
  requestData = vi.fn();
  startTimeslice?: number;

  constructor(stream: ReturnType<typeof makeStream>) {
    this.stream = stream;
    MockMediaRecorder.instances.push(this);
  }
}

/**
 * MediaRecorder sometimes never fires its stop event. A 30 second watchdog
 * then finishes the dictation. Pressing Escape during that wait marked the
 * dictation as discarded, but the watchdog kept its own "transcribe it" answer
 * from the stop press, so the cancelled dictation was transcribed and pasted
 * half a minute later into whatever window had focus by then.
 */
describe("AudioManager cancel while the recorder stop hangs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockMediaRecorder.instances = [];
    localStorageMock.clear();
    (globalThis as any).localStorage = localStorageMock;
    (window as any).electronAPI = {};
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
  });

  const recordThenStopWithoutStopEvent = async (manager: InstanceType<typeof AudioManager>) => {
    await manager.startRecording();
    const recorder = MockMediaRecorder.instances[0];
    recorder.ondataavailable?.({ data: new Blob(["spoken words"], { type: "audio/webm" }) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(manager.stopRecording()).toBe(true);
    // recorder.onstop is never called: the stop hangs.
    return recorder;
  };

  it("does not transcribe a dictation that was cancelled during the hang", async () => {
    const manager = new AudioManager();
    const processAudio = vi.spyOn(manager, "processAudio").mockResolvedValue(undefined as never);
    await recordThenStopWithoutStopEvent(manager);

    expect(manager.cancelRecording()).toBe(true);
    await vi.advanceTimersByTimeAsync(31_000);

    expect(processAudio).not.toHaveBeenCalled();
    expect(manager.getState()).toMatchObject({
      isRecording: false,
      isProcessing: false,
      isStoppingRecording: false,
    });
  });

  it("frees the app for the next dictation right after the cancel", async () => {
    const manager = new AudioManager();
    vi.spyOn(manager, "processAudio").mockResolvedValue(undefined as never);
    await recordThenStopWithoutStopEvent(manager);

    manager.cancelRecording();
    await vi.advanceTimersByTimeAsync(400);

    expect(manager.getState()).toMatchObject({ isRecording: false, isProcessing: false });
    expect(await manager.startRecording()).toBe(true);
  });

  it("still transcribes a hung stop that nobody cancelled", async () => {
    const manager = new AudioManager();
    const processAudio = vi.spyOn(manager, "processAudio").mockResolvedValue(undefined as never);
    await recordThenStopWithoutStopEvent(manager);

    await vi.advanceTimersByTimeAsync(31_000);

    expect(processAudio).toHaveBeenCalledTimes(1);
  });
});
