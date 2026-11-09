import { describe, expect, it, vi } from "vitest";

/**
 * The dictation key is registered at launch, before setup reaches the Allow
 * button. Pressing it during setup used to show the overlay and open the
 * microphone. Every dictation entry point now asks the main-process gate
 * first, and opens setup instead when the user has not allowed the microphone.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const WindowManager = require("../../../src/helpers/windowManager");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const microphoneAccess = require("../../../src/helpers/microphoneAccess");

function fakeManager() {
  const sent: string[] = [];
  const webContents = { send: (channel: string) => sent.push(channel) };
  const overlay = { isDestroyed: () => false, moveTop: () => {}, webContents };
  const manager = Object.create(WindowManager.prototype);
  Object.assign(manager, {
    hotkeyManager: { isInListeningMode: () => false },
    controlPanelWindow: { isDestroyed: () => false, webContents: {} },
    mainWindow: overlay,
    isOverlaySuppressed: () => false,
    showDictationPanel: vi.fn(async () => overlay),
    openControlPanel: vi.fn(async () => {}),
    activationModeCache: "tap",
    getActivationMode: async () => "tap",
  });
  return { manager, sent };
}

describe("dictation entry points before Allow", () => {
  for (const entry of ["sendStartDictation", "sendToggleDictation", "sendStartAgentDictation"]) {
    it(`${entry} opens setup and records nothing`, async () => {
      vi.spyOn(microphoneAccess, "resolve").mockResolvedValue(false);
      const { manager, sent } = fakeManager();

      await manager[entry]();

      expect(sent).toEqual([]);
      expect(manager.showDictationPanel).not.toHaveBeenCalled();
      expect(manager.openControlPanel).toHaveBeenCalledTimes(1);
    });
  }

  it("the hotkey callback opens setup and records nothing", async () => {
    vi.spyOn(microphoneAccess, "resolve").mockResolvedValue(false);
    const { manager, sent } = fakeManager();

    await manager.createHotkeyCallback()();

    expect(sent).toEqual([]);
    expect(manager.openControlPanel).toHaveBeenCalledTimes(1);
  });
});

describe("dictation entry points after Allow", () => {
  it("sendStartDictation reaches the overlay", async () => {
    vi.spyOn(microphoneAccess, "resolve").mockResolvedValue(true);
    const { manager, sent } = fakeManager();

    await manager.sendStartDictation(7);

    expect(sent).toEqual(["start-dictation"]);
    expect(manager.openControlPanel).not.toHaveBeenCalled();
  });

  it("the hotkey callback reaches the overlay", async () => {
    vi.spyOn(microphoneAccess, "resolve").mockResolvedValue(true);
    const { manager, sent } = fakeManager();

    await manager.createHotkeyCallback()();

    expect(sent).toEqual(["toggle-dictation"]);
  });
});
