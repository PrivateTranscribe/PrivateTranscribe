import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// debugLogger is the only thing in this dependency chain that touches electron.
vi.mock("electron", () => ({
  app: {
    getPath: () => process.cwd(),
    getName: () => "PrivateTranscribe",
  },
}));

import AgentModeHotkey from "../../../src/helpers/agentModeHotkey.js";

const { toListenerKey } = AgentModeHotkey as unknown as {
  toListenerKey: (hotkey: unknown) => string;
};

const DIAG_FLAG = "PRIVATETRANSCRIBE_DIAG_DISABLE_WINDOWS_KEY_LISTENER";

class FakeKeyManager extends EventEmitter {
  start = vi.fn();
  stop = vi.fn();
  isListening = vi.fn(() => false);
  isAvailable = vi.fn(() => true);
  resolveListenerBinary = vi.fn(() => "C:/fake/windows-key-listener.exe");
}

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

interface Harness {
  hotkey: any;
  keyManager: FakeKeyManager;
  onHoldStart: ReturnType<typeof vi.fn>;
  onHoldEnd: ReturnType<typeof vi.fn>;
}

function createHarness(): Harness {
  const keyManager = new FakeKeyManager();
  const onHoldStart = vi.fn();
  const onHoldEnd = vi.fn();
  const hotkey = new (AgentModeHotkey as any)({
    onHoldStart,
    onHoldEnd,
    createKeyManager: () => keyManager,
  });
  return { hotkey, keyManager, onHoldStart, onHoldEnd };
}

describe("AgentModeHotkey", () => {
  beforeEach(() => {
    setPlatform("win32");
    delete process.env[DIAG_FLAG];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    setPlatform(originalPlatform);
    delete process.env[DIAG_FLAG];
  });

  it("starts the listener on the Right Ctrl virtual-key code and reports registered on ready", () => {
    const { hotkey, keyManager } = createHarness();

    hotkey.apply({ enabled: true });

    expect(keyManager.start).toHaveBeenCalledTimes(1);
    expect(keyManager.start).toHaveBeenCalledWith("0xA3");
    expect(hotkey.getStatus()).toEqual({
      registered: false,
      hotkey: "RightControl",
      enabled: true,
    });

    keyManager.emit("ready");

    expect(hotkey.getStatus()).toEqual({
      registered: true,
      hotkey: "RightControl",
      enabled: true,
    });
  });

  it("turns a held key into one hold start and one hold end", () => {
    const { hotkey, keyManager, onHoldStart, onHoldEnd } = createHarness();
    hotkey.apply({ enabled: true });
    keyManager.emit("ready");

    keyManager.emit("key-down");
    expect(onHoldStart).not.toHaveBeenCalled();

    vi.advanceTimersByTime(150);
    expect(onHoldStart).toHaveBeenCalledTimes(1);
    expect(onHoldEnd).not.toHaveBeenCalled();

    keyManager.emit("key-up");
    expect(onHoldEnd).toHaveBeenCalledTimes(1);
    expect(onHoldStart).toHaveBeenCalledTimes(1);
  });

  it("ignores a tap shorter than the hold threshold", () => {
    const { hotkey, keyManager, onHoldStart, onHoldEnd } = createHarness();
    hotkey.apply({ enabled: true });
    keyManager.emit("ready");

    keyManager.emit("key-down");
    vi.advanceTimersByTime(50);
    keyManager.emit("key-up");
    vi.advanceTimersByTime(500);

    expect(onHoldStart).not.toHaveBeenCalled();
    expect(onHoldEnd).not.toHaveBeenCalled();
  });

  it("is idempotent for the same enabled hotkey", () => {
    const { hotkey, keyManager } = createHarness();

    hotkey.apply({ enabled: true, hotkey: "RightControl" });
    keyManager.emit("ready");
    hotkey.apply({ enabled: true, hotkey: "RightControl" });

    expect(keyManager.start).toHaveBeenCalledTimes(1);
    expect(keyManager.stop).not.toHaveBeenCalled();
    expect(hotkey.getStatus().registered).toBe(true);
  });

  it("stops the listener when disabled", () => {
    const { hotkey, keyManager } = createHarness();
    hotkey.apply({ enabled: true });
    keyManager.emit("ready");

    const result = hotkey.apply({ enabled: false });

    expect(keyManager.stop).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ registered: false, hotkey: "RightControl", reason: "disabled" });
    expect(hotkey.getStatus()).toEqual({
      registered: false,
      hotkey: "RightControl",
      enabled: false,
      reason: "disabled",
    });
  });

  it("restarts the same key after suspend() and reapply()", () => {
    const { hotkey, keyManager } = createHarness();
    hotkey.apply({ enabled: true });
    keyManager.emit("ready");

    const suspended = hotkey.suspend();
    expect(keyManager.stop).toHaveBeenCalledTimes(1);
    expect(suspended.reason).toBe("suspended");
    expect(hotkey.getStatus().registered).toBe(false);

    hotkey.reapply();

    expect(keyManager.start).toHaveBeenCalledTimes(2);
    expect(keyManager.start).toHaveBeenLastCalledWith("0xA3");
    expect(hotkey.getStatus().reason).toBeUndefined();
  });

  it("maps modifier names case-insensitively and passes everything else through", () => {
    expect(toListenerKey("RightControl")).toBe("0xA3");
    expect(toListenerKey("leftcontrol")).toBe("0xA2");
    expect(toListenerKey("RIGHTALT")).toBe("0xA5");
    expect(toListenerKey("LeftAlt")).toBe("0xA4");
    expect(toListenerKey("rightShift")).toBe("0xA1");
    expect(toListenerKey("LEFTSHIFT")).toBe("0xA0");
    expect(toListenerKey("F8")).toBe("F8");
    expect(toListenerKey("CommandOrControl+F9")).toBe("CommandOrControl+F9");
  });

  it("never starts a listener off Windows", () => {
    setPlatform("darwin");
    const { hotkey, keyManager } = createHarness();

    const result = hotkey.apply({ enabled: true });

    expect(keyManager.start).not.toHaveBeenCalled();
    expect(result).toEqual({ registered: false, hotkey: "RightControl", reason: "windows-only" });
  });

  it("honours the key-listener diagnostic flag", () => {
    process.env[DIAG_FLAG] = "1";
    const { hotkey, keyManager } = createHarness();

    const result = hotkey.apply({ enabled: true });

    expect(keyManager.start).not.toHaveBeenCalled();
    expect(result).toEqual({
      registered: false,
      hotkey: "RightControl",
      reason: "diagnostic-flag",
    });
  });

  it("reports unavailable when the key manager cannot run", () => {
    const { hotkey, keyManager } = createHarness();
    hotkey.apply({ enabled: true });

    keyManager.emit("unavailable", new Error("binary not found"));

    expect(hotkey.getStatus()).toEqual({
      registered: false,
      hotkey: "RightControl",
      enabled: true,
      reason: "unavailable",
    });
  });

  it("swallows a throwing hold callback instead of breaking the emitter", () => {
    const keyManager = new FakeKeyManager();
    const hotkey = new (AgentModeHotkey as any)({
      onHoldStart: () => {
        throw new Error("boom");
      },
      onHoldEnd: vi.fn(),
      createKeyManager: () => keyManager,
    });

    hotkey.apply({ enabled: true });
    keyManager.emit("ready");

    expect(() => keyManager.emit("key-down")).not.toThrow();
    expect(() => vi.advanceTimersByTime(150)).not.toThrow();
    expect(() => keyManager.emit("key-up")).not.toThrow();
  });
});
