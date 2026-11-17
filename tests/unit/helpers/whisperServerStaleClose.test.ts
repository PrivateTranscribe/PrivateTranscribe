import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * stop() waits five seconds for whisper-server to close and then moves on, so
 * a process stuck in a graphics driver can outlive its own stop. When it did
 * close, its handler cleared the manager's state, which by then described the
 * server started after it. That server kept running with nothing pointing at
 * it: every dictation started another one, and quitting the app left it alive.
 */

const WhisperServerManager = require("../../../src/helpers/whisperServer");

const MODEL_PATH = "/models/ggml-base.bin";

function fakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = undefined;
  // Already exited as far as killProcess is concerned, so stop() never signals
  // or taskkills a real process that happens to share a pid.
  child.exitCode = 0;
  child.killed = false;
  return child;
}

/** Stubs everything around the spawn that would touch this machine. */
function stubLaunch(manager: any) {
  const children: any[] = [];
  vi.spyOn(manager, "findAvailablePort").mockResolvedValue(1);
  vi.spyOn(manager, "getFFmpegPath").mockReturnValue(null);
  vi.spyOn(manager, "startHealthCheck").mockImplementation(() => {});
  vi.spyOn(manager, "_scheduleIdleCheck").mockImplementation(() => {});
  vi.spyOn(manager, "checkHealth").mockResolvedValue(true);
  vi.spyOn(manager, "_spawnServer").mockImplementation(() => {
    const child = fakeChild();
    children.push(child);
    return child;
  });
  return children;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("whisper-server process that closes after it was replaced", () => {
  it("leaves the server that replaced it running and ready", async () => {
    const manager: any = new WhisperServerManager();
    const children = stubLaunch(manager);

    await manager._startWithBinary("/fake/bin/whisper-server-cuda", MODEL_PATH);
    const stuck = children[0];

    // The stuck process does not close, so stop() gives up after five seconds.
    vi.useFakeTimers();
    const stopping = manager.stop();
    await vi.advanceTimersByTimeAsync(5000);
    await stopping;
    vi.useRealTimers();

    await manager._startWithBinary("/fake/bin/whisper-server-cpu", MODEL_PATH);
    const replacement = children[1];
    expect(manager.process).toBe(replacement);

    // Its last output must not be read as the new server's either.
    stuck.stderr.emit("data", Buffer.from("whisper_backend_init_gpu: using CUDA0 backend"));
    expect(manager.observedBackend).not.toBe("cuda");

    stuck.emit("close", 1);

    expect(manager.process).toBe(replacement);
    expect(manager.ready).toBe(true);
    expect(manager.loadedModelPath).toBe(MODEL_PATH);
  });

  it("still clears its state when the running server closes", async () => {
    const manager: any = new WhisperServerManager();
    const children = stubLaunch(manager);
    await manager._startWithBinary("/fake/bin/whisper-server-cpu", MODEL_PATH);

    children[0].emit("close", 1);

    expect(manager.process).toBeNull();
    expect(manager.ready).toBe(false);
    expect(manager.loadedModelPath).toBeNull();
  });
});
