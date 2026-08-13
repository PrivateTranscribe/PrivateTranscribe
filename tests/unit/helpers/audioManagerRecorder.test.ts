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

import AudioManager, { MISSING_SECTION_MARKER } from "../../../src/helpers/audioManager";

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

  it("starts MediaRecorder with a periodic timeslice for long dictations", async () => {
    const manager = new AudioManager();

    await manager.startRecording();

    const recorder = MockMediaRecorder.instances[0];
    expect(recorder.start).toHaveBeenCalledWith(30000);
    expect(MockMediaRecorder.instances[1].start).toHaveBeenCalledWith();
  });

  it("keeps an unconfirmed Windows paste quiet while falling back to the clipboard", async () => {
    const onError = vi.fn();
    (window as any).electronAPI = {
      pasteText: vi.fn().mockResolvedValue({ delivered: false, fallback: "clipboard" }),
    };
    const manager = new AudioManager();
    manager.setCallbacks({ onStateChange: vi.fn(), onError, onTranscriptionComplete: vi.fn() });

    await expect(manager.safePaste("recoverable text")).resolves.toBe(false);
    expect(onError).not.toHaveBeenCalled();
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
    const initialSegmentRecorder = MockMediaRecorder.instances[1];
    initialSegmentRecorder.ondataavailable?.({
      data: new Blob(["continuous first"], { type: "audio/webm" }),
    });
    await initialSegmentRecorder.onstop?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.getState().longSession.active).toBe(true);
    expect(runTranscription).toHaveBeenCalledTimes(1);
    expect(runTranscription.mock.calls[0][1]).toMatchObject({
      source: "long-session",
      skipPostProcessing: true,
    });
    await expect(runTranscription.mock.calls[0][0].text()).resolves.toBe("continuous first");

    manager.stopRecording();
    const stopPromise = recorder.onstop?.();
    await vi.advanceTimersByTimeAsync(250);
    const segmentRecorder = MockMediaRecorder.instances[2];
    segmentRecorder.ondataavailable?.({ data: new Blob(["tail"], { type: "audio/webm" }) });
    await segmentRecorder.onstop?.();
    await stopPromise;

    expect(processAudio).not.toHaveBeenCalled();
    expect(runTranscription).toHaveBeenCalledTimes(2);
    // Intermediate chunks are trimmed too: a speaker pausing to think leaves a
    // chunk ending in silence, which Whisper fills with invented sentences.
    expect(runTranscription.mock.calls[0][1]).toMatchObject({ trimTrailingSilence: true });
    expect(runTranscription.mock.calls[1][1]).toMatchObject({ trimTrailingSilence: true });
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

  it("never queues primary-recorder fragments once a long session is running", async () => {
    // The primary recorder keeps emitting timeslice blobs for the whole
    // recording. Those are mid-stream WebM with no EBML header, so FFmpeg
    // rejects them and the failure discards the entire dictation. Only the
    // segment recorders may feed the queue.
    const manager = new AudioManager();
    manager.longSessionPromotionMs = 60_000;
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
    manager.setCallbacks({
      onStateChange: vi.fn(),
      onError: vi.fn(),
      onTranscriptionComplete: vi.fn(),
    });

    await manager.startRecording();
    const recorder = MockMediaRecorder.instances[0];

    await vi.advanceTimersByTimeAsync(60_000);
    recorder.ondataavailable?.({ data: new Blob(["first"], { type: "audio/webm" }) });
    const initialSegmentRecorder = MockMediaRecorder.instances[1];
    initialSegmentRecorder.ondataavailable?.({
      data: new Blob(["promoted"], { type: "audio/webm" }),
    });
    await initialSegmentRecorder.onstop?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.getState().longSession.active).toBe(true);
    const afterPromotion = runTranscription.mock.calls.length;

    // Detach the segment recorder, then let the primary recorder flush — this
    // is the window the failing run hit at the end of a 7-minute dictation.
    manager.longSessionSegment = null;
    recorder.ondataavailable?.({ data: new Blob(["headerless fragment"], { type: "audio/webm" }) });
    await vi.advanceTimersByTimeAsync(0);

    expect(runTranscription).toHaveBeenCalledTimes(afterPromotion);
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

  it("retries a failed long-session chunk and preserves its text", async () => {
    const manager = new AudioManager();
    // Fake timers are global here, so the real backoff would never elapse.
    manager.longSessionChunkRetryBackoffMs = 0;
    const state = manager.createLongSessionState();
    state.active = true;
    state.sessionId = 42;
    manager.longSession = state;
    const attempts = new Map<number, number>();

    vi.spyOn(manager, "runTranscription").mockImplementation(async (_blob, metadata: any) => {
      const attempt = (attempts.get(metadata.chunkIndex) || 0) + 1;
      attempts.set(metadata.chunkIndex, attempt);
      if (metadata.chunkIndex === 1 && attempt === 1) {
        throw new Error("temporary provider failure");
      }
      return {
        result: { success: true, text: `chunk-${metadata.chunkIndex}`, source: "openai" },
        useLocalWhisper: false,
        localProvider: "whisper",
        activeModel: "gpt-transcribe",
      } as never;
    });
    vi.spyOn(manager, "processTranscription").mockImplementation(async (text) => text);

    manager.enqueueLongSessionChunk(new Blob(["first"]), 60_000);
    manager.enqueueLongSessionChunk(new Blob(["tail"]), 60_000);

    await manager.waitForLongSessionQueue();
    await expect(manager.finalizeLongSessionResult(120)).resolves.toMatchObject({
      success: true,
      text: "chunk-0 chunk-1",
      longSession: { chunks: 2, failedChunks: 0 },
    });
    expect(attempts.get(1)).toBe(2);
  });

  it("keeps the chunks that succeeded when one keeps failing", async () => {
    // Discarding everything used to cost the speaker every word they said
    // because one section out of several failed.
    const manager = new AudioManager();
    manager.longSessionChunkRetryBackoffMs = 0;
    const state = manager.createLongSessionState();
    state.active = true;
    state.sessionId = 43;
    manager.longSession = state;

    vi.spyOn(manager, "runTranscription").mockImplementation(async (_blob, metadata: any) => {
      if (metadata.chunkIndex === 1) {
        throw new Error("persistent provider failure");
      }
      return {
        result: { success: true, text: `chunk-${metadata.chunkIndex}`, source: "openai" },
        useLocalWhisper: false,
        localProvider: "whisper",
        activeModel: "gpt-transcribe",
      } as never;
    });
    const processTranscription = vi
      .spyOn(manager, "processTranscription")
      .mockImplementation(async (text) => text as never);

    manager.enqueueLongSessionChunk(new Blob(["first"]), 60_000);
    manager.enqueueLongSessionChunk(new Blob(["middle"]), 60_000);
    manager.enqueueLongSessionChunk(new Blob(["tail"]), 60_000);

    await manager.waitForLongSessionQueue();
    const result = await manager.finalizeLongSessionResult(180);

    // The gap sits where the missing section was spoken, not at the end, so the
    // sentences either side never silently join up into one thought.
    expect(result).toMatchObject({
      success: true,
      text: `chunk-0 ${MISSING_SECTION_MARKER} chunk-2`,
      longSession: { chunks: 2, failedChunks: 1, totalChunks: 3 },
    });
    expect(processTranscription).toHaveBeenCalledWith(
      `chunk-0 ${MISSING_SECTION_MARKER} chunk-2`,
      "long-session"
    );
  });

  it("gives a failed chunk one more attempt once the queue has drained", async () => {
    // Whatever broke the chunk mid-recording is usually gone by the end, and a
    // recovered chunk is worth far more than a marked gap.
    const manager = new AudioManager();
    manager.longSessionChunkRetryBackoffMs = 0;
    const state = manager.createLongSessionState();
    state.active = true;
    state.sessionId = 46;
    manager.longSession = state;

    let inlineAttempts = 0;
    vi.spyOn(manager, "runTranscription").mockImplementation(async (_blob, metadata: any) => {
      if (metadata.chunkIndex === 1) {
        inlineAttempts += 1;
        if (inlineAttempts <= 3) {
          throw new Error("server restarting");
        }
      }
      return {
        result: { success: true, text: `chunk-${metadata.chunkIndex}`, source: "openai" },
        useLocalWhisper: false,
        localProvider: "whisper",
        activeModel: "gpt-transcribe",
      } as never;
    });
    vi.spyOn(manager, "processTranscription").mockImplementation(async (text) => text as never);

    manager.enqueueLongSessionChunk(new Blob(["first"]), 60_000);
    manager.enqueueLongSessionChunk(new Blob(["middle"]), 60_000);

    await manager.waitForLongSessionQueue();
    const result = await manager.finalizeLongSessionResult(120);

    expect(result.text).toBe("chunk-0 chunk-1");
    expect(result.longSession).toMatchObject({ chunks: 2, failedChunks: 0 });
    expect(inlineAttempts).toBe(4);
  });

  it("puts back a gap marker that AI cleanup removed", async () => {
    // Reasoning rewrites the transcript and a bracketed marker is exactly the
    // kind of stray text it tidies away, but the gap is still real.
    const manager = new AudioManager();
    manager.longSessionChunkRetryBackoffMs = 0;
    const state = manager.createLongSessionState();
    state.active = true;
    state.sessionId = 47;
    manager.longSession = state;

    vi.spyOn(manager, "runTranscription").mockImplementation(async (_blob, metadata: any) => {
      if (metadata.chunkIndex === 0) {
        throw new Error("persistent provider failure");
      }
      return {
        result: { success: true, text: "chunk-1", source: "openai" },
        useLocalWhisper: false,
        localProvider: "whisper",
        activeModel: "gpt-transcribe",
      } as never;
    });
    vi.spyOn(manager, "processTranscription").mockResolvedValue("Polished text." as never);

    manager.enqueueLongSessionChunk(new Blob(["first"]), 60_000);
    manager.enqueueLongSessionChunk(new Blob(["tail"]), 60_000);

    await manager.waitForLongSessionQueue();
    const result = await manager.finalizeLongSessionResult(120);

    expect(result.text).toBe(`Polished text. ${MISSING_SECTION_MARKER}`);
  });

  it("still fails when no chunk survives", async () => {
    const manager = new AudioManager();
    manager.longSessionChunkRetryBackoffMs = 0;
    const state = manager.createLongSessionState();
    state.active = true;
    state.sessionId = 44;
    manager.longSession = state;

    vi.spyOn(manager, "runTranscription").mockImplementation(async () => {
      throw new Error("persistent provider failure");
    });

    manager.enqueueLongSessionChunk(new Blob(["only"]), 60_000);

    await manager.waitForLongSessionQueue();
    await expect(manager.finalizeLongSessionResult(60)).rejects.toThrow(
      "persistent provider failure"
    );
  });

  it("marks a partial transcript as incomplete so it cannot paste silently", async () => {
    const manager = new AudioManager();
    const state = manager.createLongSessionState();
    state.active = true;
    state.sessionId = 45;
    manager.longSession = state;
    // The real caller sets this before delegating; the generation guard needs it.
    manager.isProcessing = true;

    vi.spyOn(manager, "finalizeLongSessionResult").mockResolvedValue({
      success: true,
      text: "surviving text",
      source: "long-session",
      longSession: { chunks: 2, failedChunks: 1, totalChunks: 3 },
    } as never);
    const onTranscriptionComplete = vi.fn();
    const onError = vi.fn();
    manager.setCallbacks({
      onStateChange: vi.fn(),
      onError,
      onTranscriptionComplete,
    });

    await manager.processLongSessionAudio({ durationSeconds: 180 });

    expect(onError).not.toHaveBeenCalled();
    expect(onTranscriptionComplete.mock.calls[0][0].completeness).toMatchObject({
      suspicious: true,
      reason: "failed-chunks",
      failedChunks: 1,
      totalChunks: 3,
    });
  });

  it("keeps the normal recorder path if standalone segment recording is unavailable", async () => {
    const manager = new AudioManager();
    manager.longSessionPromotionMs = 60_000;
    const startSegment = vi.spyOn(manager, "startLongSessionSegmentCapture").mockReturnValue(false);

    await manager.startRecording();
    const recorder = MockMediaRecorder.instances[0];

    await vi.advanceTimersByTimeAsync(60_000);
    recorder.ondataavailable?.({ data: new Blob(["first"], { type: "audio/webm" }) });

    expect(startSegment).toHaveBeenCalledTimes(2);
    expect(manager.getState().longSession.active).toBe(false);
    expect(manager.audioChunks).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30_000);
    recorder.ondataavailable?.({ data: new Blob(["second"], { type: "audio/webm" }) });

    expect(startSegment).toHaveBeenCalledTimes(2);
    expect(manager.audioChunks).toHaveLength(2);
  });
});
