import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const WindowManager = require("../../../src/helpers/windowManager");

type KeyEvent = { type: string; holdToken?: number };

/** A window manager past its constructor, with one overlay window that records what it is sent. */
function manager(filter: ((event: KeyEvent) => unknown) | null) {
  const sent: unknown[][] = [];
  const overlay = {
    isDestroyed: () => false,
    moveTop: () => {},
    webContents: { send: (...args: unknown[]) => sent.push(args) },
  };
  const wm = Object.create(WindowManager.prototype);
  Object.assign(wm, {
    hotkeyManager: { isInListeningMode: () => false },
    mainWindow: overlay,
    isOverlaySuppressed: () => false,
    showDictationPanel: async () => overlay,
  });
  wm.setDictationKeyFilter(filter);
  return { wm, sent };
}

async function pressEverything(wm: any) {
  await wm.sendStartDictation(4);
  wm.sendStopDictation();
  wm.sendCancelDictation(4);
  await wm.sendToggleDictation();
  await wm.sendHybridDictationKeyDown();
  wm.sendHybridDictationKeyUp();
}

describe("the dictation key filter", () => {
  it("keeps every key event the answer window takes from the overlay's dictation", async () => {
    const taken: KeyEvent[] = [];
    const { wm, sent } = manager((event) => {
      taken.push(event);
      return true;
    });
    await pressEverything(wm);
    expect(sent).toEqual([]);
    expect(taken).toEqual([
      { type: "start", holdToken: 4 },
      { type: "stop" },
      { type: "cancel", holdToken: 4 },
      { type: "toggle" },
      { type: "hybrid-down" },
      { type: "hybrid-up" },
    ]);
  });

  it("dictates as before when the filter leaves the event, throws, or is not set", async () => {
    for (const filter of [
      () => false,
      () => undefined,
      () => {
        throw new Error("broken");
      },
      null,
    ]) {
      const { wm, sent } = manager(filter);
      await pressEverything(wm);
      expect(sent.map(([channel]) => channel)).toEqual([
        "start-dictation",
        "stop-dictation",
        "cancel-dictation",
        "toggle-dictation",
        "hybrid-dictation-key-down",
        "hybrid-dictation-key-up",
      ]);
    }
  });
});
