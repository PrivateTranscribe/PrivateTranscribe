import { afterEach, describe, expect, it, vi } from "vitest";
const Highlight = require("../../../src/helpers/readAloudHighlight");
const rects =
  'WORDS [{"start":0,"rects":[{"x":10,"y":20,"w":30,"h":20}]},{"start":4,"rects":[{"x":50,"y":20,"w":40,"h":20}]}]';
const state = (index = 0, start = 0) => ({
  status: "playing",
  index,
  sentence: "one two",
  word: { start, end: start + 3 },
});
function harness() {
  const h = new Highlight();
  h.isSupported = true;
  h.anchored = true;
  h.show = vi.fn(() => {
    h.active = true;
  });
  h.send = vi.fn(async () => rects);
  return h;
}
afterEach(() => vi.useRealTimers());
describe("Read Aloud highlight follow", () => {
  it("refreshes scroll geometry within 50 ms and recovers from offscreen", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.send.mockResolvedValueOnce("NONE off-screen");
    await h.onSentence(state());
    expect(h.active).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.active).toBe(true);
    expect(h.send).toHaveBeenLastCalledWith("rects");
    h.clear();
    const calls = h.send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(h.send).toHaveBeenCalledTimes(calls);
  });
  it("coalesces rapid word changes and discards a late old rectangle", async () => {
    vi.useFakeTimers();
    const h = harness();
    let resolve;
    h.send.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    const first = h.onSentence(state());
    await h.onSentence(state(0, 4));
    await h.onSentence(state(1, 0));
    expect(h.send).toHaveBeenCalledTimes(1);
    resolve(rects);
    await first;
    await Promise.resolve();
    expect(h.send).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(Buffer.from(h.send.mock.calls[1][0].slice(7), "base64").toString());
    expect(payload.index).toBe(1);
    expect(h.show).toHaveBeenCalledTimes(1);
    h.clear();
  });
  it("a stop invalidates pending work even at the same sentence index", async () => {
    const h = harness();
    let resolve;
    h.send.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    const first = h.onSentence(state());
    h.clear();
    resolve(rects);
    await first;
    expect(h.show).not.toHaveBeenCalled();
    expect(h.trackTimer).toBeNull();
  });
  it("does not restore an anchor that finished after stop", async () => {
    const h = harness();
    h.worker = {};
    h.waitForReady = async () => true;
    let resolve;
    h.send.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    const anchor = h.anchor();
    await Promise.resolve();
    h.clear();
    resolve("OK anchored");
    expect(await anchor).toBe(false);
    expect(h.anchored).toBe(false);
  });
  it("keeps an anchor while synthesizing but hides the previous word", async () => {
    const h = harness();
    await h.onSentence(state());
    await h.onSentence({ status: "synthesizing" });
    expect(h.anchored).toBe(true);
    expect(h.active).toBe(false);
    expect(h.trackTimer).toBeNull();
  });
  it("paints the next word immediately from cached geometry", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.onSentence(state());
    h.send.mockImplementation(() => new Promise(() => {}));
    void h.onSentence(state(0, 4));
    expect(h.show).toHaveBeenLastCalledWith([{ x: 50, y: 20, w: 40, h: 20 }]);
    h.clear();
  });
  it("prepares word geometry before audio starts without showing a sentence", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.onSentence({ ...state(), status: "synthesizing", word: null });
    expect(h.wordGeometry).not.toBeNull();
    expect(h.show).not.toHaveBeenCalled();
    h.send.mockImplementation(() => new Promise(() => {}));
    void h.onSentence(state());
    expect(h.show).toHaveBeenCalledTimes(1);
    h.clear();
  });
});
