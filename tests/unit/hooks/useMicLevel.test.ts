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
