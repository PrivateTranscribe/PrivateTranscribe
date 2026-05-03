import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import Module from "node:module";

const globalShortcutMock = {
  isRegistered: vi.fn(() => false),
  register: vi.fn(() => true),
  unregister: vi.fn(),
  unregisterAll: vi.fn(),
};

const originalPlatform = process.platform;
const originalLoad = (Module as unknown as { _load: typeof Module._load })._load;
let HotkeyManager: typeof import("../../../src/helpers/hotkeyManager");

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (Module as unknown as { _load: typeof Module._load })._load = function patchedLoad(
    request: string,
    parent: NodeModule | null,
    isMain: boolean
  ) {
    if (request === "electron") {
      return { globalShortcut: globalShortcutMock };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve("../../../src/helpers/hotkeyManager")];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  HotkeyManager = require("../../../src/helpers/hotkeyManager");
});

afterEach(() => {
  (Module as unknown as { _load: typeof Module._load })._load = originalLoad;
  setPlatform(originalPlatform);
});

describe("HotkeyManager hotkey compatibility", () => {
  it("keeps normal globalShortcut hotkeys compatible", () => {
    const manager = new HotkeyManager();
    expect(manager.isGlobalShortcutCompatible("CommandOrControl+Space")).toBe(true);
    expect(manager.isGlobalShortcutCompatible("F8")).toBe(true);
  });

  it("marks mouse side buttons as native-listener hotkeys", () => {
    const manager = new HotkeyManager();
    expect(manager.isGlobalShortcutCompatible("Mouse4")).toBe(false);
    expect(manager.isGlobalShortcutCompatible("Ctrl+Mouse5")).toBe(false);
  });

  it("marks locale glyph hotkeys as native-listener hotkeys", () => {
    const manager = new HotkeyManager();
    expect(manager.isGlobalShortcutCompatible("½")).toBe(false);
    expect(manager.isGlobalShortcutCompatible("CommandOrControl+½")).toBe(false);
  });

  it("normalizes Nordic half key for Windows native listener", () => {
    const manager = new HotkeyManager();
    expect(manager.normalizeForWindowsListener("½")).toBe("Backquote");
    expect(manager.normalizeForWindowsListener("CommandOrControl+½")).toBe(
      "CommandOrControl+Backquote"
    );
  });

  it("uses native listener in tap mode only for non-globalShortcut hotkeys", () => {
    const manager = new HotkeyManager();
    expect(manager.shouldUseWindowsNativeListener("CommandOrControl+Space", "tap")).toBe(false);
    expect(manager.shouldUseWindowsNativeListener("Mouse4", "tap")).toBe(true);
    expect(manager.shouldUseWindowsNativeListener("½", "tap")).toBe(true);
  });

  it("uses native listener in push mode for normal and unusual hotkeys", () => {
    const manager = new HotkeyManager();
    expect(manager.shouldUseWindowsNativeListener("CommandOrControl+Space", "push")).toBe(true);
    expect(manager.shouldUseWindowsNativeListener("Mouse4", "push")).toBe(true);
  });

  it("registers normal Windows hotkeys through Electron globalShortcut", () => {
    setPlatform("win32");
    const manager = new HotkeyManager();
    const callback = vi.fn();

    const result = manager.setupShortcuts("CommandOrControl+Space", callback);

    expect(result.success).toBe(true);
    expect(globalShortcutMock.register).toHaveBeenCalledWith(
      "CommandOrControl+Space",
      expect.any(Function)
    );
  });

  it("accepts Windows native-only hotkeys without registering an Electron accelerator", () => {
    setPlatform("win32");
    const manager = new HotkeyManager();
    const callback = vi.fn();

    const result = manager.setupShortcuts("Mouse4", callback);

    expect(result).toMatchObject({
      success: true,
      hotkey: "Mouse4",
      nativeHotkey: "Mouse4",
    });
    expect(globalShortcutMock.register).not.toHaveBeenCalled();
  });
});
