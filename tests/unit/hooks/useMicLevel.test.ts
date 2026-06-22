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
});
