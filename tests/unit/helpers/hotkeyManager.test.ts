import { beforeEach, describe, expect, it, vi } from "vitest";

const register = vi.fn(() => true);
const unregister = vi.fn();
const isRegistered = vi.fn(() => false);
const unregisterAll = vi.fn();

vi.mock("electron", () => ({
  globalShortcut: {
    register,
    unregister,
    isRegistered,
    unregisterAll,
  },
}));

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

async function loadHotkeyManager(platform: NodeJS.Platform = "win32") {
  setPlatform(platform);
  return await import("../../../src/helpers/hotkeyManager.js");
}

describe("HotkeyManager Windows native routing", () => {
  beforeEach(() => {
    register.mockClear();
    unregister.mockClear();
    isRegistered.mockClear();
    unregisterAll.mockClear();
    register.mockReturnValue(true);
    isRegistered.mockReturnValue(false);
  });

  it("keeps normal tap-mode accelerators off the Windows native listener", async () => {
    const mod = await loadHotkeyManager("win32");

    expect(mod.shouldUseWindowsNativeListener("CommandOrControl+Space", "tap")).toBe(false);
    expect(mod.shouldUseWindowsNativeListener("Control+Space", "tap")).toBe(false);
  });

  it("routes Mouse4 through the Windows native listener instead of globalShortcut", async () => {
    const mod = await loadHotkeyManager("win32");
    const HotkeyManager = mod.default ?? mod;
    const manager = new HotkeyManager();

    expect(mod.shouldUseWindowsNativeListener("Mouse4", "tap")).toBe(true);
    expect(manager.isNativeListenerHotkey("Mouse4")).toBe(true);

    const result = manager.setupShortcuts("Mouse4", vi.fn());

    expect(result.success).toBe(true);
    expect(register).not.toHaveBeenCalled();
  });

  it("routes Danish/backquote OEM keys through the Windows native listener", async () => {
    const mod = await loadHotkeyManager("win32");
    const HotkeyManager = mod.default ?? mod;
    const manager = new HotkeyManager();

    expect(mod.shouldUseWindowsNativeListener("½", "tap")).toBe(true);
    expect(mod.shouldUseWindowsNativeListener("`", "tap")).toBe(true);
    expect(manager.isNativeListenerHotkey("½")).toBe(true);
    expect(manager.isNativeListenerHotkey("`")).toBe(true);

    const result = manager.setupShortcuts("½", vi.fn());

    expect(result.success).toBe(true);
    expect(register).not.toHaveBeenCalled();
  });

  it("normalizes Danish/backquote OEM keys to Backquote for the native listener", async () => {
    const mod = await loadHotkeyManager("win32");

    expect(mod.normalizeForWindowsListener("½")).toBe("Backquote");
    expect(mod.normalizeForWindowsListener("`")).toBe("Backquote");
    expect(mod.normalizeForWindowsListener("CommandOrControl+½")).toBe(
      "CommandOrControl+Backquote"
    );
  });

  it("does not accept unknown invalid keys just because push mode is native", async () => {
    const mod = await loadHotkeyManager("win32");

    expect(mod.shouldUseWindowsNativeListener("DefinitelyNotAKey", "push")).toBe(false);
  });
});
