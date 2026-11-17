import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  app: {},
  clipboard: {
    read: vi.fn(async () => []),
    readText: vi.fn(async () => ""),
    write: vi.fn(async () => {}),
    writeText: vi.fn(async () => {}),
    clear: vi.fn(),
  },
  ClipboardItem: class {},
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ClipboardManager = require("../../../src/helpers/clipboard");

// Paste used to resolve immediately while clipboard restoration was still
// pending on a timer, so the renderer could rewrite the clipboard and then have
// the late restoration overwrite it. Restoration must complete first.
describe("ClipboardManager delayed clipboard restoration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("does not resolve before the restore delay has elapsed", async () => {
    const manager = new ClipboardManager();
    const restore = vi.spyOn(manager, "_restoreClipboard").mockImplementation(() => {});
    let settled = false;

    const pending = manager._restoreClipboardAfter({ text: "before" }, 250).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(249);
    expect(settled).toBe(false);
    expect(restore).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(restore).toHaveBeenCalledWith({ text: "before" });
    expect(settled).toBe(true);
  });

  test("restores the original snapshot once the delay elapses", async () => {
    const manager = new ClipboardManager();
    const restore = vi.spyOn(manager, "_restoreClipboard").mockImplementation(() => {});

    const pending = manager._restoreClipboardAfter({ text: "original" }, 80);
    await vi.advanceTimersByTimeAsync(80);
    await pending;

    expect(restore).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledWith({ text: "original" });
  });

  // Since Electron 44 the clipboard write behind a restore is async, so paste
  // must also wait for that write, not only for the timer.
  test("does not resolve before the async restore write has finished", async () => {
    const manager = new ClipboardManager();
    let finishWrite: () => void = () => {};
    vi.spyOn(manager, "_restoreClipboard").mockImplementation(
      () => new Promise<void>((resolve) => (finishWrite = resolve))
    );
    let settled = false;

    const pending = manager._restoreClipboardAfter({ text: "original" }, 80).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);

    finishWrite();
    await pending;
    expect(settled).toBe(true);
  });
});
