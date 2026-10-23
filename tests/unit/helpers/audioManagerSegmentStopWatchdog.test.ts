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

// A recorder whose stop never reports back, as one does when its device goes
// away mid-call.
class SilentStopRecorder {
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  start = vi.fn(() => {
    this.state = "recording";
  });
  stop = vi.fn();
  requestData = vi.fn();
}

/**
 * Ending a long dictation waits for the segment recorder's stop event. With no
 * limit, a recorder that never sent it left the dictation processing forever.
 */
describe("AudioManager long-session segment stop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as any).localStorage = localStorageMock;
    localStorageMock.clear();
    (globalThis as any).MediaRecorder = SilentStopRecorder;
    (globalThis as any).window = { electronAPI: {} };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const startSegment = () => {
    const manager: any = new AudioManager();
    manager.recordingStream = { getTracks: () => [], getAudioTracks: () => [] };
    const state = manager.createLongSessionState();
    state.active = true;
    manager.longSession = state;
    vi.spyOn(manager, "enqueueLongSessionChunk").mockImplementation(() => {});
    expect(manager.startLongSessionSegmentCapture({ promotionCapture: true })).toBe(true);
    const segment = manager.longSessionSegment;
    segment.recorder.ondataavailable({ data: new Blob(["spoken"], { type: "audio/webm" }) });
    return { manager, segment };
  };

  it("finishes the segment with what it recorded when the stop event never comes", async () => {
    const { manager } = startSegment();
    let stopped = false;
    manager.stopLongSessionSegmentCapture().then(() => {
      stopped = true;
    });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(stopped).toBe(true);
    expect(manager.enqueueLongSessionChunk).toHaveBeenCalledOnce();
    expect(manager.longSessionSegment).toBeNull();
  });

  it("finishes once when the stop event comes late", async () => {
    const { manager, segment } = startSegment();
    const stopping = manager.stopLongSessionSegmentCapture();
    await vi.advanceTimersByTimeAsync(10_000);
    await stopping;

    segment.recorder.onstop();

    expect(manager.enqueueLongSessionChunk).toHaveBeenCalledOnce();
  });
});
