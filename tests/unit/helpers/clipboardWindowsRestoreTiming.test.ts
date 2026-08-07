import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  app: {},
  clipboard: {
    readHTML: vi.fn(() => ""),
    readImage: vi.fn(() => ({ isEmpty: () => true })),
    readRTF: vi.fn(() => ""),
    readText: vi.fn(() => ""),
    write: vi.fn(),
    writeText: vi.fn(),
  },
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
});
