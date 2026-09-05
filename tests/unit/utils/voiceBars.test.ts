import { describe, expect, it } from "vitest";
import {
  VOICE_BAR_COUNT,
  VOICE_BAR_HEIGHTS,
  voiceBarHeight,
  voiceBarScale,
} from "../../../src/utils/voiceBars";

/**
 * The bars are laid out at a fixed height and driven by a vertical scale, so
 * that the microphone level reaches the screen the same way the halo's does.
 * These guard the swap: the geometry a viewer sees must be exactly what the
 * original height calculation produced.
 */
describe("voice bar geometry", () => {
  const LEVELS = [0, 0.05, 0.2, 0.5, 0.85, 1];
  const TIMES = [0, 250, 1_000, 4_321];

  it("renders the same geometry the height calculation produced", () => {
    for (const micLevel of LEVELS) {
      for (const nowMs of TIMES) {
        for (let i = 0; i < VOICE_BAR_COUNT; i++) {
          const onScreen = VOICE_BAR_HEIGHTS[i] * voiceBarScale(i, micLevel, nowMs);
          expect(onScreen).toBeCloseTo(voiceBarHeight(i, micLevel, nowMs), 10);
        }
      }
    }
  });

  it("never scales a bar past the height it was laid out at", () => {
    for (const micLevel of LEVELS) {
      for (const nowMs of TIMES) {
        for (let i = 0; i < VOICE_BAR_COUNT; i++) {
          const scale = voiceBarScale(i, micLevel, nowMs);
          expect(scale).toBeGreaterThan(0);
          expect(scale).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("keeps the centre bar the tallest and the level monotonic", () => {
    const heights = VOICE_BAR_HEIGHTS;
    expect(Math.max(...heights)).toBe(heights[2]);

    let previous = -Infinity;
    for (const micLevel of LEVELS) {
      const height = voiceBarHeight(2, micLevel, 0);
      expect(height).toBeGreaterThan(previous);
      previous = height;
    }
  });

  it("holds a floor so a silent bar is still visible", () => {
    for (let i = 0; i < VOICE_BAR_COUNT; i++) {
      // Worst case: no level and the breathing term at its lowest.
      for (const nowMs of [0, 100, 200, 300, 400, 500, 600, 700, 800]) {
        expect(voiceBarHeight(i, 0, nowMs)).toBeGreaterThanOrEqual(2);
      }
    }
  });
});
