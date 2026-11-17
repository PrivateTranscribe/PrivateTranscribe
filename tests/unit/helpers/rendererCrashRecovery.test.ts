import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const { attachRendererCrashRecovery } = require("../../../src/helpers/rendererCrashRecovery");

function fakeWindow() {
  const webContents = new EventEmitter();
  let destroyed = false;
  return {
    webContents,
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
    },
    crash: (reason = "crashed") => webContents.emit("render-process-gone", {}, { reason }),
  };
}

const quietLogger = () => ({ error: vi.fn() });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("attachRendererCrashRecovery", () => {
  it("reloads the page after it crashes, and logs it", async () => {
    const win = fakeWindow();
    const reload = vi.fn();
    const logger = quietLogger();
    attachRendererCrashRecovery(win, { label: "Dictation overlay", reload, logger });

    win.crash("oom");
    await flush();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "Dictation overlay page crashed; reloading it",
      expect.objectContaining({ reason: "oom", attempt: 1 })
    );
  });

  it("leaves a clean exit alone", async () => {
    const win = fakeWindow();
    const reload = vi.fn();
    attachRendererCrashRecovery(win, { label: "x", reload, logger: quietLogger() });
    win.crash("clean-exit");
    await flush();
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not reload a window that is already gone", async () => {
    const win = fakeWindow();
    const reload = vi.fn();
    attachRendererCrashRecovery(win, { label: "x", reload, logger: quietLogger() });
    win.destroy();
    win.crash();
    await flush();
    expect(reload).not.toHaveBeenCalled();
  });

  it("stops after three reloads in a minute, and tries again once the minute has passed", async () => {
    const win = fakeWindow();
    const reload = vi.fn();
    let clock = 0;
    attachRendererCrashRecovery(win, {
      label: "x",
      reload,
      logger: quietLogger(),
      now: () => clock,
    });

    for (let i = 0; i < 5; i += 1) {
      win.crash();
      clock += 1_000;
    }
    await flush();
    expect(reload).toHaveBeenCalledTimes(3);

    clock += 60_000;
    win.crash();
    await flush();
    expect(reload).toHaveBeenCalledTimes(4);
  });

  it("logs a reload that fails instead of throwing", async () => {
    const win = fakeWindow();
    const logger = quietLogger();
    attachRendererCrashRecovery(win, {
      label: "x",
      reload: () => Promise.reject(new Error("load failed")),
      logger,
    });
    win.crash();
    await flush();
    expect(logger.error).toHaveBeenLastCalledWith("x reload after a crash failed", {
      error: "load failed",
    });
  });
});
