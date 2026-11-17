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

// One track object per stream, the way a real MediaStream hands out the same
// track on every getTracks() call. stop() ends it, as in the browser.
const makeStream = () => {
  const track = {
    label: "Test microphone",
    getSettings: () => ({ deviceId: "test-device", sampleRate: 48000, channelCount: 1 }),
    readyState: "live",
    muted: false,
    stop: vi.fn(() => {
      track.readyState = "ended";
    }),
  };
  return {
    active: true,
    track,
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };
};

class MockMediaRecorder {
  static instances: MockMediaRecorder[] = [];

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

  constructor(public stream: ReturnType<typeof makeStream>) {
    MockMediaRecorder.instances.push(this);
  }
}

const fireDeviceChange = () => {
  const addEventListener = navigator.mediaDevices.addEventListener as ReturnType<typeof vi.fn>;
  const registration = addEventListener.mock.calls.find(([type]) => type === "devicechange");
  expect(registration).toBeDefined();
  registration![1]();
};

// Ends the dictation without transcribing it, which releases the recorder the
// same way a finished dictation does.
const endDictation = async (manager: InstanceType<typeof AudioManager>) => {
  manager.cancelRecording();
  const stopPromise = MockMediaRecorder.instances[0].onstop?.();
  await vi.advanceTimersByTimeAsync(250);
  await stopPromise;
};

describe("AudioManager when Windows reports an audio device change", () => {
  let streams: ReturnType<typeof makeStream>[];

  beforeEach(() => {
    vi.useFakeTimers();
    MockMediaRecorder.instances = [];
    streams = [];
    localStorageMock.clear();
    (globalThis as any).localStorage = localStorageMock;
    (window as any).electronAPI = {};
    (globalThis as any).MediaRecorder = MockMediaRecorder;
    Object.defineProperty(globalThis, "navigator", {
      value: {
        mediaDevices: {
          enumerateDevices: vi.fn().mockResolvedValue([]),
          getUserMedia: vi.fn(async () => {
            const stream = makeStream();
            streams.push(stream);
            return stream;
          }),
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

  it("keeps the microphone open while a dictation is recording", async () => {
    const manager = new AudioManager();
    await manager.startRecording();
    expect(manager.getState().isRecording).toBe(true);

    fireDeviceChange();

    expect(streams[0].track.stop).not.toHaveBeenCalled();
    expect(streams[0].track.readyState).toBe("live");
  });

  it("opens the microphone again for the next dictation after a change mid-recording", async () => {
    const manager = new AudioManager();
    await manager.startRecording();
    fireDeviceChange();

    await endDictation(manager);
    expect(manager.getState().isRecording).toBe(false);

    // The warm stream was opened before the change, so it may sit on a
    // microphone that is no longer the one Windows would pick.
    expect(streams[0].track.stop).toHaveBeenCalled();
    await manager.startRecording();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("still closes the warm microphone when the change lands between dictations", async () => {
    const manager = new AudioManager();
    await manager.startRecording();
    await endDictation(manager);
    expect(streams[0].track.stop).not.toHaveBeenCalled();

    fireDeviceChange();

    expect(streams[0].track.stop).toHaveBeenCalledOnce();
  });
});
