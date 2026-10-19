import { describe, expect, it, vi } from "vitest";

const { createWindowsHoldDictation } = require("../../../src/helpers/windowsHoldDictation");

/**
 * A window manager with the overlay off. The first start creates the window and
 * sends once it has loaded; anything sent while it loads is lost, as
 * windowManager assigns mainWindow before the load finishes. The "renderer"
 * keeps the hold number the way useAudioRecording does.
 */
function overlayOffWindow() {
  const log: string[] = [];
  let state: "none" | "loading" | "ready" = "none";
  let finishLoad = () => {};
  const renderer = { recordingHold: null as number | null };

  const deliver = (message: string, hold?: number) => {
    if (state !== "ready") {
      log.push(`DROPPED ${message} ${hold ?? ""}`.trim());
      return;
    }
    log.push(`${message} ${hold ?? ""}`.trim());
    if (message === "start" && renderer.recordingHold === null) renderer.recordingHold = hold ?? 0;
    if (message === "cancel" && hold !== undefined && renderer.recordingHold === hold) {
      renderer.recordingHold = null;
    }
    if (message === "stop") renderer.recordingHold = null;
  };

  const windowManager = {
    sendToggleDictation: vi.fn(),
    sendStartDictation: vi.fn(async (hold: number) => {
      if (state === "none") {
        state = "loading";
        await new Promise<void>((resolve) => {
          finishLoad = () => {
            state = "ready";
            resolve();
          };
        });
      }
      deliver("start", hold);
    }),
    sendStopDictation: vi.fn(() => deliver("stop")),
    sendCancelDictation: vi.fn((hold: number) => deliver("cancel", hold)),
  };

  return { windowManager, renderer, log, finishLoad: () => finishLoad() };
}

const logger = { debug: () => {}, warn: () => {} };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createWindowsHoldDictation", () => {
  it("cancels a hold's recording even when a newer hold began while the window loaded", async () => {
    const window = overlayOffWindow();
    const hold = createWindowsHoldDictation({ windowManager: window.windowManager, logger });

    hold.onHoldStart(); // hold 1 creates the window
    hold.onHoldCancel(); // a click: cancel 1 is lost in the load
    hold.onHoldStart(); // hold 2 starts during the load: start 2 is lost
    window.finishLoad(); // start 1 arrives and begins a recording
    await settle();
    hold.onHoldCancel(); // cancel 2 does not match hold 1

    expect(window.log).toEqual([
      "DROPPED cancel 1",
      "DROPPED start 2",
      "start 1",
      "cancel 1",
      "cancel 2",
    ]);
    expect(window.renderer.recordingHold).toBeNull();
  });

  it("still stops a released hold whose start arrived late", async () => {
    const window = overlayOffWindow();
    const hold = createWindowsHoldDictation({ windowManager: window.windowManager, logger });

    hold.onHoldStart();
    hold.onHoldEnd();
    window.finishLoad();
    await settle();

    expect(window.log).toEqual(["DROPPED stop", "start 1", "stop"]);
    expect(window.renderer.recordingHold).toBeNull();
  });

  it("forgets a cancelled hold once its cancel is sent again", async () => {
    const window = overlayOffWindow();
    const hold = createWindowsHoldDictation({ windowManager: window.windowManager, logger });

    hold.onHoldStart();
    hold.onHoldCancel();
    window.finishLoad();
    await settle();
    hold.onHoldStart(); // hold 2, window ready
    await settle();

    expect(window.log).toEqual(["DROPPED cancel 1", "start 1", "cancel 1", "start 2"]);
    expect(window.renderer.recordingHold).toBe(2);
  });
});
