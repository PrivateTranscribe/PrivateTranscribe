import { describe, expect, it } from "vitest";

const { resolveWhisperThreads } = require("../../../src/helpers/cpuThreads");

/**
 * The real probe shells out to PowerShell/sysctl/procfs, which a unit test has
 * no business doing, so the topology is injected instead. What is under test is
 * the policy, not the platform detection.
 */
const topology = (physicalCores: number, logicalCores: number) => ({
  physicalCores,
  logicalCores,
});

describe("resolveWhisperThreads", () => {
  describe("auto", () => {
    it.each([
      // [physical, logical, expected, why]
      [16, 32, 15, "big desktop keeps one core back"],
      [8, 16, 7, "mid laptop keeps one core back"],
      [6, 12, 5, "six cores can still spare one"],
      [4, 8, 4, "four cores are not taxed - a quarter of the machine is too much"],
      [2, 4, 4, "dual core keeps whisper.cpp's old default rather than dropping to 2"],
      [1, 1, 1, "single core never goes below one thread"],
      [1, 2, 2, "the floor cannot exceed the logical core count"],
      [64, 128, 16, "workstation is capped rather than fully consumed"],
      [24, 24, 16, "no SMT, still capped"],
    ])("%i physical / %i logical -> %i threads (%s)", (physical, logical, expected) => {
      expect(resolveWhisperThreads(0, topology(physical, logical))).toBe(expected);
    });

    it("beats whisper.cpp's own default of 4 on any machine bigger than a laptop", () => {
      expect(resolveWhisperThreads(0, topology(16, 32))).toBeGreaterThan(4);
    });

    it("is never a downgrade, whatever the machine looks like", () => {
      // The reserve-a-core rule on its own would hand a 2-core machine fewer
      // threads than it had before, which is the opposite of the point.
      for (let physical = 1; physical <= 64; physical += 1) {
        for (const logical of [physical, physical * 2]) {
          const before = Math.min(4, logical);
          expect(resolveWhisperThreads(0, topology(physical, logical))).toBeGreaterThanOrEqual(
            before
          );
        }
      }
    });

    it("treats an unset or unparseable setting as auto", () => {
      for (const setting of [undefined, null, "", "auto", Number.NaN, 0, -4]) {
        expect(resolveWhisperThreads(setting as never, topology(8, 16))).toBe(7);
      }
    });
  });

  describe("manual override", () => {
    it("uses the requested count", () => {
      expect(resolveWhisperThreads(24, topology(16, 32))).toBe(24);
    });

    it("accepts a numeric string, since it arrives from an input field", () => {
      expect(resolveWhisperThreads("12" as never, topology(16, 32))).toBe(12);
    });

    it("never exceeds the logical core count", () => {
      expect(resolveWhisperThreads(999, topology(16, 32))).toBe(32);
    });

    it("is not subject to the auto cap - an override means the user meant it", () => {
      expect(resolveWhisperThreads(32, topology(16, 32))).toBe(32);
    });
  });
});
