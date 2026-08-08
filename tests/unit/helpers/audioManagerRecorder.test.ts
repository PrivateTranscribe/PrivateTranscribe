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

describe("AudioManager recorder lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockMediaRecorder.instances = [];
    localStorageMock.clear();
    (globalThis as any).localStorage = localStorageMock;
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

  it("starts MediaRecorder with a periodic timeslice for long dictations", async () => {
    const manager = new AudioManager();

    await manager.startRecording();

    const recorder = MockMediaRecorder.instances[0];
    expect(recorder.start).toHaveBeenCalledWith(30000);
  });

  it("does not force-process partial recorder chunks after only 2.5 seconds", async () => {
    const manager = new AudioManager();
    const processAudio = vi.spyOn(manager, "processAudio").mockResolvedValue(undefined as never);

    await manager.startRecording();
    const recorder = MockMediaRecorder.instances[0];
    recorder.ondataavailable?.({ data: new Blob(["first chunk"], { type: "audio/webm" }) });

    await vi.advanceTimersByTimeAsync(500);
    manager.stopRecording();
    await vi.advanceTimersByTimeAsync(2500);

    expect(processAudio).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(27500);
    expect(processAudio).toHaveBeenCalledTimes(1);
    expect(processAudio.mock.calls[0][0].size).toBeGreaterThan(0);
  });

  it("includes final recorder data that arrives just after stop", async () => {
    const manager = new AudioManager();
    const processAudio = vi.spyOn(manager, "processAudio").mockResolvedValue(undefined as never);

    await manager.startRecording();
    const recorder = MockMediaRecorder.instances[0];
    recorder.ondataavailable?.({ data: new Blob(["first chunk "], { type: "audio/webm" }) });

    await vi.advanceTimersByTimeAsync(500);
    manager.stopRecording();
    const stopPromise = recorder.onstop?.();
    recorder.ondataavailable?.({ data: new Blob(["final tail"], { type: "audio/webm" }) });

    await vi.advanceTimersByTimeAsync(249);
    expect(processAudio).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await stopPromise;

    expect(processAudio).toHaveBeenCalledTimes(1);
    await expect(processAudio.mock.calls[0][0].text()).resolves.toBe("first chunk final tail");
  });

  it("discards sub-500ms recordings without entering transcription", async () => {
    const manager = new AudioManager();
    const processAudio = vi.spyOn(manager, "processAudio").mockResolvedValue(undefined as never);
    const onStateChange = vi.fn();
    manager.setCallbacks({
      onStateChange,
      onError: vi.fn(),
      onTranscriptionComplete: vi.fn(),
    });

    await manager.startRecording();
    const recorder = MockMediaRecorder.instances[0];
    recorder.ondataavailable?.({ data: new Blob(["tiny capture"], { type: "audio/webm" }) });

    await vi.advanceTimersByTimeAsync(499);
    expect(manager.stopRecording()).toBe(true);
    expect(onStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ isRecording: false, isProcessing: false })
    );

    const stopPromise = recorder.onstop?.();
    await vi.advanceTimersByTimeAsync(250);
    await stopPromise;

    expect(processAudio).not.toHaveBeenCalled();
    expect(manager.getState()).toMatchObject({
      isRecording: false,
      isProcessing: false,
      isStoppingRecording: false,
    });
  });

  it("discards a push-to-talk release that arrives before microphone startup finishes", async () => {
    const manager = new AudioManager();
    const processAudio = vi.spyOn(manager, "processAudio").mockResolvedValue(undefined as never);
    let resolveStream!: (stream: ReturnType<typeof makeStream>) => void;
    const streamPromise = new Promise<ReturnType<typeof makeStream>>((resolve) => {
      resolveStream = resolve;
    });
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      streamPromise
    );

    const startPromise = manager.startRecording();
    await Promise.resolve();
    await Promise.resolve();

    expect(manager.getState().isStartingRecording).toBe(true);
    expect(manager.stopRecording()).toBe(true);

    resolveStream(makeStream());
    await startPromise;

    const recorder = MockMediaRecorder.instances[0];
    expect(recorder.stop).toHaveBeenCalledOnce();
    const stopPromise = recorder.onstop?.();
    await vi.advanceTimersByTimeAsync(250);
    await stopPromise;

    expect(processAudio).not.toHaveBeenCalled();
    expect(manager.getState()).toMatchObject({
      isRecording: false,
      isProcessing: false,
      isStartingRecording: false,
      isStoppingRecording: false,
    });
  });

  it("keeps the transcription path for recordings at least 500ms long", async () => {
    const manager = new AudioManager();
    const processAudio = vi.spyOn(manager, "processAudio").mockResolvedValue(undefined as never);
    const onStateChange = vi.fn();
    manager.setCallbacks({
      onStateChange,
      onError: vi.fn(),
      onTranscriptionComplete: vi.fn(),
    });

    await manager.startRecording();
    const recorder = MockMediaRecorder.instances[0];
    recorder.ondataavailable?.({ data: new Blob(["valid capture"], { type: "audio/webm" }) });

    await vi.advanceTimersByTimeAsync(500);
    manager.stopRecording();
    expect(onStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ isRecording: false, isProcessing: true })
    );
    const stopPromise = recorder.onstop?.();
    await vi.advanceTimersByTimeAsync(250);
    await stopPromise;

    expect(processAudio).toHaveBeenCalledTimes(1);
  });

  it("recovers immediately when MediaRecorder throws while stopping", async () => {
    const manager = new AudioManager();
    const processAudio = vi.spyOn(manager, "processAudio").mockResolvedValue(undefined as never);
    const onStateChange = vi.fn();
    manager.setCallbacks({
      onStateChange,
      onError: vi.fn(),
      onTranscriptionComplete: vi.fn(),
    });

    await manager.startRecording();
    const recorder = MockMediaRecorder.instances[0];
    recorder.stop.mockImplementationOnce(() => {
      throw new DOMException("Recorder was not ready", "InvalidStateError");
    });

    expect(manager.stopRecording()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(processAudio).not.toHaveBeenCalled();
    expect(manager.getState()).toMatchObject({
      isRecording: false,
      isProcessing: false,
      isStoppingRecording: false,
    });
    expect(onStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ isRecording: false, isProcessing: false })
    );
  });

  it("ignores duplicate stop while waiting for final recorder data", async () => {
    const manager = new AudioManager();
    const processAudio = vi.spyOn(manager, "processAudio").mockResolvedValue(undefined as never);

    await manager.startRecording();
    const recorder = MockMediaRecorder.instances[0];
    recorder.ondataavailable?.({ data: new Blob(["first chunk "], { type: "audio/webm" }) });

    await vi.advanceTimersByTimeAsync(500);
    expect(manager.stopRecording()).toBe(true);
    const stopPromise = recorder.onstop?.();
    expect(manager.stopRecording()).toBe(true);
    recorder.ondataavailable?.({ data: new Blob(["final tail"], { type: "audio/webm" }) });

    await vi.advanceTimersByTimeAsync(249);
    expect(processAudio).not.toHaveBeenCalled();
    expect(recorder.stop).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await stopPromise;

    expect(processAudio).toHaveBeenCalledTimes(1);
    await expect(processAudio.mock.calls[0][0].text()).resolves.toBe("first chunk final tail");
  });

  it("preserves transcription stream events split inside the data prefix", async () => {
    const manager = new AudioManager();
    const encoder = new TextEncoder();
    const chunks = [
      "da",
      'ta: {"type":"transcript.text.delta","delta":"hello "}\n\n',
      'data: {"type":"transcript.text.delta","delta":"world"}\n\n',
      "data: [DONE]\n\n",
    ];

    const response = {
      body: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      }),
    };

    await expect(manager.readTranscriptionStream(response)).resolves.toBe("hello world");
  });

  it("flushes a final transcription stream event without a trailing newline", async () => {
    const manager = new AudioManager();
    const encoder = new TextEncoder();
    const response = {
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"type":"transcript.text.delta","delta":"final text"}')
          );
          controller.close();
        },
      }),
    };

    await expect(manager.readTranscriptionStream(response)).resolves.toBe("final text");
  });

  it("promotes long recordings to background chunk transcription and finalizes merged text once", async () => {
    const manager = new AudioManager();
    manager.longSessionPromotionMs = 60_000;
    const processAudio = vi.spyOn(manager, "processAudio");
    const runTranscription = vi
      .spyOn(manager, "runTranscription")
      .mockImplementation(async (_blob, metadata: any) => ({
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
    const processTranscription = vi
      .spyOn(manager, "processTranscription")
      .mockImplementation(async (text) => `final:${text}`);
    const onTranscriptionComplete = vi.fn();
    manager.setCallbacks({
      onStateChange: vi.fn(),
      onError: vi.fn(),
      onTranscriptionComplete,
    });

    await manager.startRecording();
    const recorder = MockMediaRecorder.instances[0];

    await vi.advanceTimersByTimeAsync(60_000);
    recorder.ondataavailable?.({ data: new Blob(["first"], { type: "audio/webm" }) });
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.getState().longSession.active).toBe(true);
    expect(runTranscription).toHaveBeenCalledTimes(1);
    expect(runTranscription.mock.calls[0][1]).toMatchObject({
      source: "long-session",
      skipPostProcessing: true,
    });

    manager.stopRecording();
    const stopPromise = recorder.onstop?.();
    await vi.advanceTimersByTimeAsync(250);
    const segmentRecorder = MockMediaRecorder.instances[1];
    segmentRecorder.ondataavailable?.({ data: new Blob(["tail"], { type: "audio/webm" }) });
    await segmentRecorder.onstop?.();
    await stopPromise;

    expect(processAudio).not.toHaveBeenCalled();
    expect(runTranscription).toHaveBeenCalledTimes(2);
    expect(processTranscription).toHaveBeenCalledTimes(1);
    expect(processTranscription).toHaveBeenCalledWith("chunk-0 chunk-1", "long-session");
    expect(onTranscriptionComplete).toHaveBeenCalledTimes(1);
    expect(onTranscriptionComplete.mock.calls[0][0]).toMatchObject({
      success: true,
      text: "final:chunk-0 chunk-1",
      source: "long-session",
      longSession: {
        chunks: 2,
        failedChunks: 0,
      },
    });
    expect(manager.getState().longSession.active).toBe(false);
  });

  it("cancels queued long-session work without completing transcription", async () => {
    const manager = new AudioManager();
    manager.longSessionPromotionMs = 60_000;
    const onTranscriptionComplete = vi.fn();
    manager.setCallbacks({
      onStateChange: vi.fn(),
      onError: vi.fn(),
      onTranscriptionComplete,
    });
    vi.spyOn(manager, "runTranscription").mockResolvedValue({
      result: {
        success: true,
        text: "chunk",
        source: "openai",
        timings: {},
      },
      useLocalWhisper: false,
      localProvider: "whisper",
      activeModel: "gpt-transcribe",
    } as never);

    await manager.startRecording();
    const recorder = MockMediaRecorder.instances[0];

    await vi.advanceTimersByTimeAsync(60_000);
    recorder.ondataavailable?.({ data: new Blob(["first"], { type: "audio/webm" }) });
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.getState().longSession.active).toBe(true);

    manager.cancelRecording();
    const stopPromise = recorder.onstop?.();
    await vi.advanceTimersByTimeAsync(250);
    await stopPromise;

    expect(onTranscriptionComplete).not.toHaveBeenCalled();
    expect(manager.getState().longSession.active).toBe(false);
  });

  it("keeps the normal recorder path if standalone segment recording is unavailable", async () => {
    const manager = new AudioManager();
    manager.longSessionPromotionMs = 60_000;
    const startSegment = vi.spyOn(manager, "startLongSessionSegmentCapture").mockReturnValue(false);

    await manager.startRecording();
    const recorder = MockMediaRecorder.instances[0];

    await vi.advanceTimersByTimeAsync(60_000);
    recorder.ondataavailable?.({ data: new Blob(["first"], { type: "audio/webm" }) });

    expect(startSegment).toHaveBeenCalledTimes(1);
    expect(manager.getState().longSession.active).toBe(false);
    expect(manager.audioChunks).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30_000);
    recorder.ondataavailable?.({ data: new Blob(["second"], { type: "audio/webm" }) });

    expect(startSegment).toHaveBeenCalledTimes(1);
    expect(manager.audioChunks).toHaveLength(2);
  });
});
