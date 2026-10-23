import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The health check probes whisper-server every 5 seconds and marks it not
 * ready when a probe fails. A probe can fail on a busy or just-woken machine
 * while the server is fine, and nothing ever set ready again: the idle unload
 * stopped, the engine read as stopped, and the next dictation killed and
 * cold-started a working server.
 */

const WhisperServerManager = require("../../../src/helpers/whisperServer");

describe("whisper-server health check", () => {
  let manager: any;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new WhisperServerManager();
    manager.process = { pid: undefined };
    manager.ready = true;
    manager.idleTimeoutMs = 30 * 60 * 1000;
    manager.lastUsedTime = Date.now();
  });

  afterEach(() => {
    manager.stopHealthCheck();
    manager._clearIdleCheck();
    vi.useRealTimers();
  });

  it("marks the server ready again once a probe succeeds", async () => {
    const answers = [false, true];
    manager.checkHealth = vi.fn(async () => answers.shift() ?? true);

    manager.startHealthCheck();
    await vi.advanceTimersByTimeAsync(5000);
    expect(manager.ready).toBe(false);

    await vi.advanceTimersByTimeAsync(5000);
    expect(manager.ready).toBe(true);
  });

  it("schedules the idle unload again after it recovers", async () => {
    const answers = [false, true];
    manager.checkHealth = vi.fn(async () => answers.shift() ?? true);

    manager.startHealthCheck();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(manager.idleCheckTimeout).toBeTruthy();
  });

  it("stays not ready while probes keep failing", async () => {
    manager.checkHealth = vi.fn(async () => false);

    manager.startHealthCheck();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(manager.ready).toBe(false);
  });

  it("does not mark a server ready that was replaced while the probe ran", async () => {
    let answer!: (healthy: boolean) => void;
    manager.checkHealth = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        })
    );
    manager.ready = false;

    manager.startHealthCheck();
    await vi.advanceTimersByTimeAsync(5000);
    manager.process = { pid: undefined };
    answer(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.ready).toBe(false);
  });
});
