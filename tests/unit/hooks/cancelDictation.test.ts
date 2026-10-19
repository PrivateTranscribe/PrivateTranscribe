import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const ActivationGestureController = require("../../../src/helpers/activationGestureController");

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
  vi.stubGlobal("window", { electronAPI: bridge });
  const hook = useAudioRecording(vi.fn());
  harness.effects.forEach((fn) => fn());
  return { manager: hook.audioManagerRef.current, events, bridge };
}

/**
 * The real gesture controller wired to the hook the way main.js wires it, with
 * the IPC hop replaced by direct calls.
 */
function controllerFor(events: Record<string, (token?: number) => void>) {
  let holdToken = 0;
  return new ActivationGestureController({
    mode: "tapHold",
    onTap: () => events.onToggleDictation(),
    onHoldStart: () => {
      holdToken += 1;
      events.onStartDictation(holdToken);
    },
    onHoldEnd: () => events.onStopDictation(),
    onHoldCancel: () => events.onCancelDictation(holdToken),
  });
}

beforeEach(() => {
  harness.effects = [];
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("cancel-dictation", () => {
  it("discards a recording the cancelled hold started", async () => {
    const { manager, events, bridge } = mount();
    const controller = controllerFor(events);

    controller.keyDown();
    vi.advanceTimersByTime(150);
    await Promise.resolve();
    expect(manager.startRecording).toHaveBeenCalledOnce();

    controller.discard();
    controller.keyUp();

    expect(manager.cancelRecording).toHaveBeenCalledOnce();
    expect(manager.stopRecording).not.toHaveBeenCalled();
    expect(bridge.notifyDictationCompleted).toHaveBeenCalledOnce();
  });

  it("keeps a hands-free dictation that was already running", async () => {
    const { manager, events } = mount();
    const controller = controllerFor(events);

    // Tap to start hands-free, then hold the hotkey inside another shortcut.
    controller.keyDown();
    controller.keyUp();
    await Promise.resolve();
    expect(manager.startRecording).toHaveBeenCalledOnce();

    controller.keyDown();
    vi.advanceTimersByTime(400);
    controller.discard();
    controller.keyUp();

    expect(manager.cancelRecording).not.toHaveBeenCalled();
    expect(manager.stopRecording).not.toHaveBeenCalled();
    expect(manager.getState().isRecording).toBe(true);
  });

  it("leaves a dictation being transcribed alone, window included", async () => {
    const { manager, events, bridge } = mount();
    events.onToggleDictation();
    await Promise.resolve();
    events.onToggleDictation();
    manager.state.isProcessing = true;

    events.onStartDictation(7);
    events.onCancelDictation(7);

    expect(manager.cancelRecording).not.toHaveBeenCalled();
    expect(bridge.notifyDictationCompleted).not.toHaveBeenCalled();
  });

  it("ignores a cancel for a hold that has already ended", async () => {
    const { manager, events, bridge } = mount();
    events.onStartDictation(1);
    await Promise.resolve();
    events.onStopDictation();
    events.onToggleDictation();
    await Promise.resolve();

    events.onCancelDictation(1);

    expect(manager.cancelRecording).not.toHaveBeenCalled();
    expect(bridge.notifyDictationCompleted).not.toHaveBeenCalled();
  });

  it("does nothing when nothing is recording", () => {
    const { manager, events, bridge } = mount();

    events.onCancelDictation(1);

    expect(manager.cancelRecording).not.toHaveBeenCalled();
    expect(manager.stopRecording).not.toHaveBeenCalled();
    expect(bridge.notifyDictationCompleted).not.toHaveBeenCalled();
  });
});
