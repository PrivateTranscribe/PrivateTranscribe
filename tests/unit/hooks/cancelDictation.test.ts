import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A held hotkey that turns out to be part of another shortcut or a mouse action
 * (Ctrl+Shift+click) sends cancel-dictation. The recording is a false start, so
 * it is discarded rather than transcribed and pasted.
 */

const harness = vi.hoisted(() => ({
  effects: [] as Array<() => unknown>,
}));
vi.mock("react", () => ({
  default: { createElement: vi.fn() },
  useState: (value: unknown) => [value, vi.fn()],
  useRef: (current: unknown) => ({ current }),
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => unknown) => harness.effects.push(fn),
}));
vi.mock("../../../src/helpers/audioManager", () => ({
  MISSING_SECTION_MARKER: "missing",
  default: class {
    codingPromptSession = false;
    state = { isRecording: false, isProcessing: false, isStartingRecording: false };
    getState = () => this.state;
    setCallbacks = vi.fn();
    startRecording = vi.fn(async () => {
      this.state.isRecording = true;
      return true;
    });
    stopRecording = vi.fn(() => {
      this.state.isRecording = false;
      return true;
    });
    cancelRecording = vi.fn(() => {
      this.state.isRecording = false;
    });
    cleanup = vi.fn();
  },
}));
vi.mock("../../../src/utils/analytics", () => ({
  trackAnalyticsEvent: vi.fn(),
  trackAnalyticsEventOnce: vi.fn(),
  buildTranscriptionAnalyticsProperties: vi.fn(),
}));
import { useAudioRecording } from "../../../src/hooks/useAudioRecording";

function mount() {
  const events: Record<string, () => void> = {};
  const bridge: Record<string, any> = Object.fromEntries(
    ["onToggleDictation", "onStartDictation", "onStopDictation", "onCancelDictation"].map(
      (name) => [
        name,
        vi.fn((fn) => {
          events[name] = fn;
          return vi.fn();
        }),
      ]
    )
  );
  bridge.notifyDictationCompleted = vi.fn(async () => {});
  vi.stubGlobal("window", { electronAPI: bridge });
  const hook = useAudioRecording(vi.fn());
  harness.effects.forEach((fn) => fn());
  return { manager: hook.audioManagerRef.current, events, bridge };
}

beforeEach(() => {
  harness.effects = [];
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});

describe("cancel-dictation", () => {
  it("discards a recording the hotkey started instead of transcribing it", async () => {
    const { manager, events, bridge } = mount();
    events.onStartDictation();
    await Promise.resolve();
    expect(manager.startRecording).toHaveBeenCalledOnce();

    events.onCancelDictation();

    expect(manager.cancelRecording).toHaveBeenCalledOnce();
    expect(manager.stopRecording).not.toHaveBeenCalled();
    expect(bridge.notifyDictationCompleted).toHaveBeenCalledOnce();
  });

  it("does nothing to the recorder when nothing is recording", () => {
    const { manager, events } = mount();

    events.onCancelDictation();

    expect(manager.cancelRecording).not.toHaveBeenCalled();
    expect(manager.stopRecording).not.toHaveBeenCalled();
  });
});
