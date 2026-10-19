import { afterEach, describe, expect, it, vi } from "vitest";

// The in-place highlight sits directly above the window the text lives in,
// not above every window, so whatever covers the source app covers the
// highlight too. Windows' own z-order does the hiding; these tests pin the
// part this code owns: which window it stacks on, and that it keeps doing so
// while the highlight is up. The real stacking is checked on screen by
// tests/e2e/readaloud-highlight.spec.ts.
const Highlight = require("../../../src/helpers/readAloudHighlight.js");
const { parseAnchorWindow, STACK_INTERVAL_MS } = Highlight;

function fakeWindow({ topmost = false } = {}) {
  const win = {
    topmost,
    destroyed: false,
    isDestroyed: () => win.destroyed,
    isVisible: () => true,
    hide: vi.fn(),
    isAlwaysOnTop: () => win.topmost,
    setAlwaysOnTop: vi.fn((on: boolean) => {
      win.topmost = on;
    }),
    moveAbove: vi.fn(),
  };
  return win;
}

function harness(sourceWindow: { hwnd: number; topmost: boolean } | null) {
  const h = new Highlight();
  const win = fakeWindow();
  h.window = win;
  h.sourceWindow = sourceWindow;
  h.active = true;
  return { h, win };
}

afterEach(() => vi.useRealTimers());

describe("parseAnchorWindow", () => {
  it("reads the source window's handle and pin state from the anchor reply", () => {
    expect(parseAnchorWindow("OK chars=42 hwnd=133090 topmost=0 window=Notes - Notepad")).toEqual({
      hwnd: 133090,
      topmost: false,
    });
    expect(parseAnchorWindow("OK chars=7 hwnd=4242 topmost=1 window=Sticky")).toEqual({
      hwnd: 4242,
      topmost: true,
    });
  });

  it("keeps a sign-extended handle signed, the way Electron parses it", () => {
    expect(parseAnchorWindow("OK chars=1 hwnd=-2147352418 topmost=0 window=x")?.hwnd).toBe(
      -2147352418
    );
  });

  it("names no window for a failed anchor, a missing handle or a zero handle", () => {
    expect(parseAnchorWindow("ERR nothing has focus")).toBeNull();
    expect(parseAnchorWindow("OK chars=12 window=Old worker")).toBeNull();
    expect(parseAnchorWindow("OK chars=12 hwnd=0 topmost=0 window=x")).toBeNull();
  });

  it("is not fooled by a window title that looks like the fields", () => {
    expect(parseAnchorWindow("OK chars=3 hwnd=77 topmost=0 window=hwnd=99 topmost=1")).toEqual({
      hwnd: 77,
      topmost: false,
    });
  });
});

describe("stacking on the source window", () => {
  it("stacks directly above the source window instead of above everything", () => {
    const { h, win } = harness({ hwnd: 133090, topmost: false });
    h.stackAboveSource();
    expect(win.moveAbove).toHaveBeenCalledWith("window:133090:0");
    expect(win.topmost).toBe(false);
  });

  it("pins itself when the source window is pinned, so it can sit on it", () => {
    const { h, win } = harness({ hwnd: 4242, topmost: true });
    h.stackAboveSource();
    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true);
    expect(win.moveAbove).toHaveBeenCalledWith("window:4242:0");
  });

  it("unpins itself for an ordinary source after a pinned one", () => {
    const { h, win } = harness({ hwnd: 77, topmost: false });
    win.topmost = true;
    h.stackAboveSource();
    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(false);
    expect(win.moveAbove).toHaveBeenCalledWith("window:77:0");
  });

  it("stays above every window when it has no source window to stand on", () => {
    const { h, win } = harness(null);
    h.stackAboveSource();
    expect(win.moveAbove).not.toHaveBeenCalled();
    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
  });

  it("falls back to above every window when Electron refuses the handle", () => {
    const { h, win } = harness({ hwnd: 31337, topmost: false });
    win.moveAbove.mockImplementation(() => {
      throw new Error("Invalid media source id");
    });
    h.stackAboveSource();
    expect(h.sourceWindow).toBeNull();
    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(true, "screen-saver");
    expect(h.active).toBe(true);
  });

  it("does nothing while hidden", () => {
    const { h, win } = harness({ hwnd: 77, topmost: false });
    h.active = false;
    h.stackAboveSource();
    expect(win.moveAbove).not.toHaveBeenCalled();
  });

  it("retakes its place on a timer while up, and stops when hidden", () => {
    vi.useFakeTimers();
    const { h, win } = harness({ hwnd: 77, topmost: false });
    h.startStacking();
    expect(win.moveAbove).toHaveBeenCalledTimes(1);
    // Activating the source app lifts it over the highlight; the next tick
    // puts the highlight back on top of it.
    vi.advanceTimersByTime(STACK_INTERVAL_MS * 3);
    expect(win.moveAbove).toHaveBeenCalledTimes(4);
    h.startStacking();
    vi.advanceTimersByTime(STACK_INTERVAL_MS);
    expect(win.moveAbove).toHaveBeenCalledTimes(6);

    h.hide();
    expect(h.stackTimer).toBeNull();
    vi.advanceTimersByTime(STACK_INTERVAL_MS * 5);
    expect(win.moveAbove).toHaveBeenCalledTimes(6);
  });

  it("forgets the source window when the read ends", () => {
    const { h } = harness({ hwnd: 77, topmost: false });
    h.send = vi.fn(async () => "OK");
    h.anchored = true;
    h.clear();
    expect(h.sourceWindow).toBeNull();
    expect(h.stackTimer).toBeNull();
  });
});

describe("anchoring", () => {
  it("remembers the window the anchor reply names", async () => {
    const h = new Highlight();
    h.isSupported = true;
    h.worker = {};
    h.waitForReady = async () => true;
    h.send = vi.fn(async () => "OK chars=20 hwnd=5150 topmost=0 window=Doc - Word");
    expect(await h.anchor()).toBe(true);
    expect(h.sourceWindow).toEqual({ hwnd: 5150, topmost: false });
    expect(h.getStatus().sourceWindow).toEqual({ hwnd: 5150, topmost: false });
  });
});
