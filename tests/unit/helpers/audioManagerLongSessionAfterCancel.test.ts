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
 * A dictation longer than a minute is transcribed in chunks while it records.
 * Pressing Escape during its final processing does not stop work already sent
 * off, such as an AI cleanup call. When that work came back, the old job reset
 * the long-dictation state, which by then belonged to the next dictation: its
 * recording segment was thrown away and every minute already transcribed was
 * dropped.
 */
describe("AudioManager long dictation started after a cancelled one", () => {
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

  const text = (value: string) => new Blob([value], { type: "audio/webm" });

  /** Lets queued chunk work and the steps after it run to their next wait. */
  const settle = async () => {
    for (let turn = 0; turn < 10; turn += 1) {
      await vi.advanceTimersByTimeAsync(0);
    }
  };

  /** Records past the one-minute mark, so the dictation becomes a long session. */
  const recordPastPromotion = async (manager: InstanceType<typeof AudioManager>) => {
    const first = MockMediaRecorder.instances.length;
    await manager.startRecording();
    const recorder = MockMediaRecorder.instances[first];
    await vi.advanceTimersByTimeAsync(60_000);
    recorder.ondataavailable?.({ data: text("timeslice") });
    const promotionSegment = MockMediaRecorder.instances[first + 1];
    promotionSegment.ondataavailable?.({ data: text("first minute") });
    await promotionSegment.onstop?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.getState().longSession.active).toBe(true);
    return recorder;
  };

  /** Stops the dictation and hands over the last recorded segment. */
  const stopAndDeliverTail = async (
    manager: InstanceType<typeof AudioManager>,
    recorder: MockMediaRecorder
  ) => {
    const tailSegment = MockMediaRecorder.instances[MockMediaRecorder.instances.length - 1];
    manager.stopRecording();
    const stopped = recorder.onstop?.();
    await vi.advanceTimersByTimeAsync(250);
    tailSegment.ondataavailable?.({ data: text("tail") });
    await tailSegment.onstop?.();
    return stopped;
  };

  it("keeps the new dictation whole when the cancelled one finishes late", async () => {
    const manager = new AudioManager();
    manager.longSessionPromotionMs = 60_000;
    vi.spyOn(manager, "runTranscription").mockImplementation(async (_blob, metadata: any) => ({
      result: {
        success: true,
        text: `minute-${metadata.chunkIndex + 1}`,
        source: "openai",
        timings: {},
      },
      useLocalWhisper: false,
      localProvider: "whisper",
      activeModel: "gpt-transcribe",
    }));
    let finishOldCleanup!: (text: string) => void;
    const processTranscription = vi
      .spyOn(manager, "processTranscription")
      .mockImplementationOnce(() => new Promise<string>((resolve) => (finishOldCleanup = resolve)))
      .mockImplementation(async (joined: string) => joined);
    const onTranscriptionComplete = vi.fn();
    manager.setCallbacks({ onStateChange: vi.fn(), onError: vi.fn(), onTranscriptionComplete });

    // The first long dictation is stopped and then cancelled while its cleanup
    // call is still out.
    const oldRecorder = await recordPastPromotion(manager);
    const oldStopped = stopAndDeliverTail(manager, oldRecorder);
    await settle();
    expect(processTranscription).toHaveBeenCalledTimes(1);
    expect(manager.cancelProcessing()).toBe(true);

    // The next long dictation is already past its first minute when the old
    // cleanup call comes back.
    const newRecorder = await recordPastPromotion(manager);
    const newSegment = MockMediaRecorder.instances[MockMediaRecorder.instances.length - 1];
    finishOldCleanup("old dictation");
    await oldStopped;
    await settle();

    expect(manager.getState().longSession.active).toBe(true);
    expect(newSegment.stop).not.toHaveBeenCalled();

    await stopAndDeliverTail(manager, newRecorder);
    await settle();

    expect(onTranscriptionComplete).toHaveBeenCalledTimes(1);
    expect(onTranscriptionComplete.mock.calls[0][0]).toMatchObject({
      text: "minute-1 minute-2",
      longSession: { chunks: 2, failedChunks: 0 },
    });
  });
  it("does not let the cancelled dictation read the new one while its last chunk is still out", async () => {
    const manager = new AudioManager();
    manager.longSessionPromotionMs = 60_000;
    let holdNextChunk = false;
    let releaseOldChunk!: () => void;
    vi.spyOn(manager, "runTranscription").mockImplementation(async (_blob, metadata: any) => {
      if (holdNextChunk) {
        holdNextChunk = false;
        await new Promise<void>((resolve) => (releaseOldChunk = resolve));
      }
      return {
        result: {
          success: true,
          text: `minute-${metadata.chunkIndex + 1}`,
          source: "openai",
          timings: {},
        },
        useLocalWhisper: false,
        localProvider: "whisper",
        activeModel: "gpt-transcribe",
      };
    });
    const processTranscription = vi
      .spyOn(manager, "processTranscription")
      .mockImplementation(async (joined: string) => joined);
    const onTranscriptionComplete = vi.fn();
    manager.setCallbacks({ onStateChange: vi.fn(), onError: vi.fn(), onTranscriptionComplete });

    // The first long dictation is cancelled while its last chunk is still
    // being transcribed.
    const oldRecorder = await recordPastPromotion(manager);
    holdNextChunk = true;
    const oldStopped = stopAndDeliverTail(manager, oldRecorder);
    await settle();
    expect(manager.cancelProcessing()).toBe(true);

    const newRecorder = await recordPastPromotion(manager);
    const newSegment = MockMediaRecorder.instances[MockMediaRecorder.instances.length - 1];
    releaseOldChunk();
    await oldStopped;
    await settle();

    // The old job must not pick up the new dictation's first minute.
    expect(processTranscription).not.toHaveBeenCalled();
    expect(manager.getState().longSession.active).toBe(true);
    expect(newSegment.stop).not.toHaveBeenCalled();

    await stopAndDeliverTail(manager, newRecorder);
    await settle();

    expect(processTranscription).toHaveBeenCalledTimes(1);
    expect(onTranscriptionComplete).toHaveBeenCalledTimes(1);
    expect(onTranscriptionComplete.mock.calls[0][0]).toMatchObject({
      text: "minute-1 minute-2",
      longSession: { chunks: 2, failedChunks: 0 },
    });
  });
});
