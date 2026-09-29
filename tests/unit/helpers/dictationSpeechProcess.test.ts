import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { prepareDictationSpeech } = require("../../../src/helpers/dictationSpeechRunner");

afterEach(() => vi.useRealTimers());

function start(options = {}) {
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(),
    postMessage: vi.fn(),
  });
  const pcm = Buffer.from([1, 0, 2, 0]);
  const result = prepareDictationSpeech(pcm, {
    modelPath: "model.onnx",
    createProcess: () => child,
    ...options,
  });
  return { child, pcm, result };
}

describe("speech detector process isolation", () => {
  it("falls back on a native access violation and accepts the next recording", async () => {
    const first = start();
    first.child.emit("spawn");
    first.child.emit("exit", 0xc0000005);
    expect(await first.result).toEqual({ available: false, reason: "worker-exited" });
    expect(first.pcm).toEqual(Buffer.from([1, 0, 2, 0]));

    const next = start();
    expect(next.child.postMessage).not.toHaveBeenCalled();
    next.child.emit("spawn");
    expect(next.child.postMessage).toHaveBeenCalledWith({
      pcm: Uint8Array.from(next.pcm),
      modelPath: "model.onnx",
    });
    next.child.emit("message", {
      ok: true,
      pcm: Uint8Array.from(next.pcm),
      mode: "unchanged",
      regions: 0,
    });
    next.child.emit("exit", 0);
    expect(await next.result).toEqual({
      available: true,
      pcm: next.pcm,
      mode: "unchanged",
      regions: 0,
    });
    expect(next.child.kill).toHaveBeenCalledOnce();
  });

  it.each(["abort", "timeout"])("never sends audio after %s before spawn", async (action) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { child, result } = start({ signal: controller.signal, timeoutMs: 10 });
    if (action === "abort") controller.abort();
    else await vi.advanceTimersByTimeAsync(10);
    child.emit("spawn");
    expect(await result).toEqual({
      available: false,
      reason: action === "abort" ? "cancelled" : "timeout",
    });
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(child.postMessage).not.toHaveBeenCalled();
  });

  it("falls back if spawning or sending fails", async () => {
    const failed = start({
      createProcess: () => {
        throw new Error("spawn failed");
      },
    });
    expect(await failed.result).toMatchObject({ available: false });
    const { child, result } = start();
    child.postMessage.mockImplementation(() => {
      throw new Error("channel closed");
    });
    child.emit("spawn");
    expect(await result).toMatchObject({ available: false });
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("rejects malformed results without touching the original audio", async () => {
    const { child, result, pcm } = start();
    child.emit("message", { ok: true, pcm: "invalid" });
    expect(await result).toEqual({ available: false, reason: "invalid-result" });
    expect(pcm).toEqual(Buffer.from([1, 0, 2, 0]));
  });
});
