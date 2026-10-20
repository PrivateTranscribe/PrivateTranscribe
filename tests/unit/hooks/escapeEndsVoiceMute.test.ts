import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Escape during a recording discards it. A discarded recording never reaches
 * onTranscriptionComplete, which is where a finished dictation lets go of the
 * voice call's mute key, so the cancel has to let go of it itself. Before it
 * did, the call stayed muted until the helper's 10-minute timeout or the next
 * dictation.
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
      return true;
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

const settings: Record<string, string> = {
  muteVoiceCallOnRecord: "true",
  voiceCallMuteKey: "F13",
  musicDuckingMode: "duck",
  pauseMediaOnRecord: "true",
};

function mount() {
  const events: Record<string, (token?: number) => void> = {};
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
  bridge.voiceMuteStart = vi.fn(async () => ({ muted: true, reason: "held" }));
  bridge.voiceMuteStop = vi.fn(async () => ({ released: true }));
  bridge.duckSystemAudio = vi.fn();
  bridge.restoreSystemAudio = vi.fn();
  bridge.mediaPause = vi.fn();
  bridge.mediaResume = vi.fn();
  vi.stubGlobal("window", { electronAPI: bridge });
  const hook = useAudioRecording(vi.fn());
  harness.effects.forEach((fn) => fn());
  return { hook, manager: hook.audioManagerRef.current, events, bridge };
}

beforeEach(() => {
  harness.effects = [];
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => settings[key] ?? null,
    setItem: () => {},
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Escape during a recording", () => {
  it("releases the voice call's mute key", async () => {
    const { hook, manager, bridge } = mount();

    await hook.startRecording();
    expect(manager.startRecording).toHaveBeenCalledOnce();
    expect(bridge.voiceMuteStart).toHaveBeenCalledWith({ key: "F13" });

    hook.cancelRecording();

    expect(manager.cancelRecording).toHaveBeenCalledOnce();
    expect(bridge.voiceMuteStop).toHaveBeenCalledOnce();
  });

  it("still restores the volume and resumes media", async () => {
    const { hook, bridge } = mount();

    await hook.startRecording();
    hook.cancelRecording();

    expect(bridge.restoreSystemAudio).toHaveBeenCalled();
    expect(bridge.mediaResume).toHaveBeenCalledOnce();
    expect(bridge.notifyDictationCompleted).toHaveBeenCalledOnce();
  });

  it("releases the key once, not again when the next dictation ends", async () => {
    const { hook, bridge } = mount();

    await hook.startRecording();
    hook.cancelRecording();
    hook.stopRecording();

    expect(bridge.voiceMuteStop).toHaveBeenCalledOnce();
  });
});
