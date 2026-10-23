import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Correction Memory watches the clipboard for 30 seconds after a dictation, so
 * the user can copy a fixed version and get a "Teach Correction Memory" toast.
 * The audio manager marks the dictation as no longer processing the moment the
 * completion callback returns, so the watch has to outlive that.
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
    callbacks: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    state = { isRecording: false, isProcessing: false, isStartingRecording: false };
    getState = () => this.state;
    setCallbacks = vi.fn((callbacks) => {
      this.callbacks = callbacks;
    });
    startRecording = vi.fn(async () => true);
    stopRecording = vi.fn(() => true);
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
let clipboard: string;

function mount() {
  const listeners = Object.fromEntries(
    [
      "onToggleDictation",
      "onStartDictation",
      "onStopDictation",
      "onHybridDictationKeyDown",
      "onHybridDictationKeyUp",
    ].map((name) => [name, vi.fn(() => vi.fn())])
  );
  vi.stubGlobal("window", {
    electronAPI: {
      ...listeners,
      readClipboard: vi.fn(async () => clipboard),
      confirmCorrection: vi.fn(async () => undefined),
    },
  });
  const toast = vi.fn();
  const hook = useAudioRecording(toast);
  harness.effects.forEach((fn) => fn());
  const manager = hook.audioManagerRef.current;
  return { manager, toast };
}

// The same contract the audio manager hands the callback: current only while
// that dictation is still processing, latest until a newer one starts.
function completeDictation(manager: any, text: string) {
  let processing = true;
  let latest = true;
  const done = manager.callbacks
    .onTranscriptionComplete(
      { success: true, text },
      { isCurrent: () => processing, isLatest: () => latest }
    )
    .then((value: unknown) => {
      processing = false;
      return value;
    });
  return { done, supersede: () => (latest = false) };
}

const teachToasts = (toast: ReturnType<typeof vi.fn>) =>
  toast.mock.calls.filter(([options]) => options?.title === "Teach Correction Memory");

beforeEach(() => {
  vi.useFakeTimers();
  harness.effects = [];
  clipboard = "restart the kubernets pod";
  store = new Map([
    ["enableVariableSnapping", "false"],
    ["betaFeaturesEnabled", "true"],
    ["enableCorrectionLearning", "true"],
  ]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Correction Memory clipboard watch", () => {
  it("offers to learn a correction copied after the dictation finished", async () => {
    const { manager, toast } = mount();
    const { done } = completeDictation(manager, "restart the kubernets pod");
    await done;

    clipboard = "restart the kubernetes pod";
    await vi.advanceTimersByTimeAsync(800);

    expect(teachToasts(toast)).toHaveLength(1);
  });

  it("stops watching once a newer dictation starts", async () => {
    const { manager, toast } = mount();
    const { done, supersede } = completeDictation(manager, "restart the kubernets pod");
    await done;
    supersede();

    clipboard = "restart the kubernetes pod";
    await vi.advanceTimersByTimeAsync(800);

    expect(teachToasts(toast)).toHaveLength(0);
  });

  it("stops watching after 30 seconds", async () => {
    const { manager, toast } = mount();
    const { done } = completeDictation(manager, "restart the kubernets pod");
    await done;
    await vi.advanceTimersByTimeAsync(31_000);

    clipboard = "restart the kubernetes pod";
    await vi.advanceTimersByTimeAsync(800);

    expect(teachToasts(toast)).toHaveLength(0);
  });
});
