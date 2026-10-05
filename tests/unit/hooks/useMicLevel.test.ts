import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetMicLevelAudioContextForTests,
  waitForAudioContextRunning,
} from "../../../src/hooks/useMicLevel.js";

describe("useMicLevel audio context recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
    __resetMicLevelAudioContextForTests();
  });

  it("rejects a running context whose clock never advances during startup", async () => {
    vi.useFakeTimers();
    const ctx = { state: "running", currentTime: 42, resume: vi.fn() };
    const result = waitForAudioContextRunning(ctx, { requireClockProgress: true });
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toBe(false);
    expect(ctx.resume).not.toHaveBeenCalled();
  });

  it("accepts a rendering context without requiring any microphone volume", async () => {
    vi.useFakeTimers();
    const ctx = { state: "running", currentTime: 42, resume: vi.fn() };
    const result = waitForAudioContextRunning(ctx, { requireClockProgress: true });
    ctx.currentTime += 0.01;
    await vi.advanceTimersByTimeAsync(50);
    await expect(result).resolves.toBe(true);
  });

  it("requires clock progress after a suspended context resumes", async () => {
    vi.useFakeTimers();
    const ctx = {
      state: "suspended",
      currentTime: 0,
      resume: vi.fn(async () => {
        ctx.state = "running";
      }),
    };
    const result = waitForAudioContextRunning(ctx, { requireClockProgress: true });
    await vi.advanceTimersByTimeAsync(100);
    ctx.currentTime = 0.01;
    await vi.advanceTimersByTimeAsync(50);
    await expect(result).resolves.toBe(true);
    expect(ctx.resume).toHaveBeenCalledOnce();
  });

  it("reports running when resume wakes a suspended AudioContext", async () => {
    const ctx = {
      state: "suspended",
      resume: vi.fn(async () => {
        ctx.state = "running";
      }),
    };

    await expect(waitForAudioContextRunning(ctx, { attempts: 2, delayMs: 1 })).resolves.toBe(true);
    expect(ctx.resume).toHaveBeenCalledOnce();
  });

  it("reports failure when resume resolves but the AudioContext remains suspended", async () => {
    vi.useFakeTimers();

    const ctx = {
      state: "suspended",
      resume: vi.fn().mockResolvedValue(undefined),
    };

    const result = waitForAudioContextRunning(ctx, { attempts: 3, delayMs: 10 });

    await vi.advanceTimersByTimeAsync(30);

    await expect(result).resolves.toBe(false);
    expect(ctx.resume).toHaveBeenCalledOnce();
  });

  it("times out even when resume never settles", async () => {
    vi.useFakeTimers();
    const ctx = { state: "suspended", resume: vi.fn(() => new Promise(() => {})) };
    const result = waitForAudioContextRunning(ctx, { attempts: 3, delayMs: 10 });
    await vi.advanceTimersByTimeAsync(30);
    await expect(result).resolves.toBe(false);
  });

  it("allows a late resume rejection after its timeout", async () => {
    vi.useFakeTimers();
    let rejectResume!: (error: Error) => void;
    const ctx = {
      state: "suspended",
      resume: () =>
        new Promise((_, reject) => {
          rejectResume = reject;
        }),
    };
    const result = waitForAudioContextRunning(ctx, { attempts: 1, delayMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toBe(false);
    rejectResume(new Error("context closed during recovery"));
    await vi.advanceTimersByTimeAsync(0);
  });
});
