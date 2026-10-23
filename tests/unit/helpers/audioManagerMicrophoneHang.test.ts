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

import AudioManager from "../../../src/helpers/audioManager";

const makeStream = () => {
  const track = {
    label: "Microphone Array (Realtek Audio)",
    getSettings: () => ({ deviceId: "default", sampleRate: 48000, channelCount: 1 }),
    stop: vi.fn(),
    readyState: "live",
    muted: false,
  };
  return { active: true, track, getAudioTracks: () => [track], getTracks: () => [track] };
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
 * getUserMedia can hang when the Windows audio service stops answering. The
 * recording then waited forever with isStartingRecording set, and every later
 * hotkey press was ignored until the app restarted.
 */
describe("AudioManager when the microphone never answers", () => {
  let getUserMedia: ReturnType<typeof vi.fn>;
  let answerLate: ((stream: ReturnType<typeof makeStream>) => void) | null;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorageMock.clear();
    (globalThis as any).localStorage = localStorageMock;
    (globalThis as any).MediaRecorder = MockMediaRecorder;
    answerLate = null;
    getUserMedia = vi.fn(
      () =>
        new Promise((resolve) => {
          answerLate = resolve;
        })
    );
    Object.defineProperty(globalThis, "navigator", {
      value: {
        mediaDevices: {
          enumerateDevices: vi.fn().mockResolvedValue([]),
          getUserMedia,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        },
      },
      writable: true,
      configurable: true,
    });
    (globalThis as any).window.electronAPI = {};
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).window.electronAPI;
  });

  it("gives up, says so, and lets the next press start a recording", async () => {
    const manager: any = new AudioManager();
    manager.onError = vi.fn();

    const first = manager.startRecording();
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(first).resolves.toBe(false);
    expect(manager.isStartingRecording).toBe(false);
    expect(manager.onError).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Microphone Not Responding" })
    );

    getUserMedia.mockResolvedValue(makeStream());
    await expect(manager.startRecording()).resolves.toBe(true);
  });

  it("closes a microphone that opens after it gave up", async () => {
    const manager: any = new AudioManager();
    manager.onError = vi.fn();

    const first = manager.startRecording();
    await vi.advanceTimersByTimeAsync(15_000);
    await first;

    const late = makeStream();
    answerLate?.(late);
    await vi.advanceTimersByTimeAsync(0);

    // The privacy promise: no open microphone the app is not using.
    expect(late.track.stop).toHaveBeenCalled();
  });

  it("waits for a slow microphone that answers in time", async () => {
    const manager: any = new AudioManager();
    manager.onError = vi.fn();

    const first = manager.startRecording();
    await vi.advanceTimersByTimeAsync(5_000);
    answerLate?.(makeStream());

    await expect(first).resolves.toBe(true);
    expect(manager.onError).not.toHaveBeenCalled();
  });
});
