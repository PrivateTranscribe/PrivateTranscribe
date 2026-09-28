import { beforeEach, describe, expect, it, vi } from "vitest";

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
  const bridge = Object.fromEntries(
    [
      "onToggleDictation",
      "onStartDictation",
      "onStopDictation",
      "onHybridDictationKeyDown",
      "onHybridDictationKeyUp",
      "onStartAgentDictation",
      "onStopAgentDictation",
    ].map((name) => [
      name,
      vi.fn((fn) => {
        events[name] = fn;
        return vi.fn();
      }),
    ])
  );
  vi.stubGlobal("window", { electronAPI: bridge });
  const toast = vi.fn();
  const hook = useAudioRecording(toast);
  harness.effects.forEach((fn) => fn());
  return { hook, manager: hook.audioManagerRef.current, events, bridge, toast };
}

beforeEach(() => {
  harness.effects = [];
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});

describe("Agent mode through the normal dictation flow", () => {
  it.each(["onToggleDictation", "onStartDictation", "onHybridDictationKeyDown"])(
    "uses the setting for %s",
    async (event) => {
      localStorage.setItem("agentModeDictationEnabled", "true");
      const { events, manager } = mount();
      events[event]();
      await Promise.resolve();
      expect(manager.startRecording).toHaveBeenCalledOnce();
      expect(manager.codingPromptSession).toBe(true);
    }
  );
  it("ignores the old default and never subscribes to the separate key", async () => {
    localStorage.setItem("agentModeEnabled", "true");
    const { hook, manager, bridge } = mount();
    await hook.startRecording();
    expect(manager.codingPromptSession).toBe(false);
    expect(bridge.onStartAgentDictation).not.toHaveBeenCalled();
    expect(bridge.onStopAgentDictation).not.toHaveBeenCalled();
  });
  it("applies changes to the next recording, including the record button", async () => {
    localStorage.setItem("agentModeDictationEnabled", "true");
    const { hook, manager } = mount();
    await hook.startRecording();
    localStorage.setItem("agentModeDictationEnabled", "false");
    await hook.startRecording();
    expect(manager.codingPromptSession).toBe(true);
    hook.stopRecording();
    await hook.startRecording();
    expect(manager.codingPromptSession).toBe(false);
  });
  it.each([false, "reject"])("clears agent mode when recording fails: %s", async (failure) => {
    localStorage.setItem("agentModeDictationEnabled", "true");
    const { hook, manager } = mount();
    if (failure === "reject") manager.startRecording.mockRejectedValueOnce(new Error("mic"));
    else manager.startRecording.mockResolvedValueOnce(false);
    await hook.startRecording().catch(() => {});
    expect(manager.codingPromptSession).toBe(false);
  });
  it("Agent mode is never blocked", async () => {
    localStorage.setItem("agentModeDictationEnabled", "true");
    // The record an install kept from when Agent mode had a daily cap.
    localStorage.setItem(
      "privatetranscribe_agent_mode_usage_v1",
      JSON.stringify({ date: new Date().toLocaleDateString("sv"), usesToday: 20, limit: 20 })
    );
    const { hook, manager, toast, bridge } = mount();
    bridge.openControlPanel = vi.fn();
    for (let i = 0; i < 25; i += 1) {
      await hook.startRecording();
      expect(manager.codingPromptSession).toBe(true);
      hook.stopRecording();
    }
    expect(manager.startRecording).toHaveBeenCalledTimes(25);
    expect(toast).not.toHaveBeenCalled();
    expect(bridge.openControlPanel).not.toHaveBeenCalled();
  });
});
