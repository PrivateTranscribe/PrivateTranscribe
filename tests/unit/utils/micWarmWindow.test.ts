import { describe, expect, it } from "vitest";
import {
  resolveMicWarmWindowMs,
  DEFAULT_MIC_WARM_WINDOW_MS,
} from "../../../src/utils/micWarmWindow";

describe("resolveMicWarmWindowMs", () => {
  it("falls back to the default when unset, empty, or invalid", () => {
    expect(resolveMicWarmWindowMs(null)).toBe(DEFAULT_MIC_WARM_WINDOW_MS);
    expect(resolveMicWarmWindowMs(undefined)).toBe(DEFAULT_MIC_WARM_WINDOW_MS);
    expect(resolveMicWarmWindowMs("")).toBe(DEFAULT_MIC_WARM_WINDOW_MS);
    expect(resolveMicWarmWindowMs("abc")).toBe(DEFAULT_MIC_WARM_WINDOW_MS);
    expect(resolveMicWarmWindowMs(-5)).toBe(DEFAULT_MIC_WARM_WINDOW_MS);
  });

  it("treats 0 as 'keep warm indefinitely' (never auto-release)", () => {
    expect(resolveMicWarmWindowMs("0")).toBe(0);
    expect(resolveMicWarmWindowMs(0)).toBe(0);
  });

  it("converts a seconds value to milliseconds", () => {
    expect(resolveMicWarmWindowMs("15")).toBe(15000);
    expect(resolveMicWarmWindowMs("30")).toBe(30000);
    expect(resolveMicWarmWindowMs(60)).toBe(60000);
    expect(resolveMicWarmWindowMs(120)).toBe(120000);
  });

  it("honors a custom fallback", () => {
    expect(resolveMicWarmWindowMs(null, 30000)).toBe(30000);
  });
});
