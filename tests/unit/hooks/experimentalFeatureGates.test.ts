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
    callbacks: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    state = { isRecording: false, isProcessing: false, isStartingRecording: false };
    getState = () => this.state;
    setCallbacks = vi.fn((callbacks) => {
      this.callbacks = callbacks;
    });
    startRecording = vi.fn(async () => {
      this.state.isRecording = true;
      return true;
    });
    stopRecording = vi.fn(() => {
      this.state.isRecording = false;
      return true;
    });
    cancelRecording = vi.fn();
    cleanup = vi.fn();
    saveTranscription = vi.fn(async () => true);
    recordTranscriptionActivity = vi.fn(async () => undefined);
    safePaste = vi.fn(async () => ({ delivered: true, dispatched: true }));
  },
}));
vi.mock("../../../src/utils/analytics", () => ({
  trackAnalyticsEvent: vi.fn(),
  trackAnalyticsEventOnce: vi.fn(),
  buildTranscriptionAnalyticsProperties: vi.fn(),
}));
import { useAudioRecording } from "../../../src/hooks/useAudioRecording";

let store: Map<string, string>;

function mount() {
  const actionEngineMatch = vi.fn(async () => ({ success: true, matches: [] }));
  const listeners = Object.fromEntries(
    [
      "onToggleDictation",
      "onStartDictation",
      "onStopDictation",
      "onHybridDictationKeyDown",
      "onHybridDictationKeyUp",
    ].map((name) => [name, vi.fn(() => vi.fn())])
  );
  vi.stubGlobal("window", { electronAPI: { ...listeners, actionEngineMatch } });
  const hook = useAudioRecording(vi.fn());
  harness.effects.forEach((fn) => fn());
  const manager = hook.audioManagerRef.current;
  const dictate = async (text: string) => {
    await hook.startRecording();
    const session = manager.codingPromptSession;
    await manager.callbacks.onTranscriptionComplete({ success: true, text });
    return session;
  };
  return { manager, dictate, actionEngineMatch };
}

beforeEach(() => {
  harness.effects = [];
  store = new Map([
    ["enableVariableSnapping", "false"],
    ["agentModeRewrite", "false"],
    ["betaFeaturesEnabled", "true"],
  ]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
});

describe("Agent Mode behind the experimental switch", () => {
  it("treats a saved Agent Mode as off and never presses Enter while the switch is off", async () => {
    store.set("agentModeDictationEnabled", "true");
    const { manager, dictate } = mount();

    expect(await dictate("fix the login bug send")).toBe(false);
    expect(manager.safePaste).toHaveBeenCalledWith("fix the login bug send", {});
    expect(store.get("agentModeDictationEnabled")).toBe("true");
  });

  it("runs Agent Mode as before once the switch is on", async () => {
    store.set("agentModeDictationEnabled", "true");
    store.set("experimentalFeatures", "true");
    const { manager, dictate } = mount();

    expect(await dictate("fix the login bug send")).toBe(true);
    expect(manager.safePaste).toHaveBeenCalledWith(expect.any(String), { sendEnter: true });
  });
});

describe("Action Engine behind the experimental switch", () => {
  it("never matches dictated text while the switch is off, even with beta features on", async () => {
    const { manager, dictate, actionEngineMatch } = mount();

    await dictate("open notes");
    expect(actionEngineMatch).not.toHaveBeenCalled();
    expect(manager.safePaste).toHaveBeenCalledOnce();
  });

  it("matches dictated text once the switch is on", async () => {
    store.set("experimentalFeatures", "true");
    const { dictate, actionEngineMatch } = mount();

    await dictate("open notes");
    expect(actionEngineMatch).toHaveBeenCalledWith("open notes");
  });

  it("still needs beta features, as it did before the switch existed", async () => {
    store.set("experimentalFeatures", "true");
    store.set("betaFeaturesEnabled", "false");
    const { dictate, actionEngineMatch } = mount();

    await dictate("open notes");
    expect(actionEngineMatch).not.toHaveBeenCalled();
  });
});
