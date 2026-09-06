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

  it("renders the geometry the height calculation asks for", () => {
    for (const micLevel of LEVELS) {
      for (let i = 0; i < VOICE_BAR_COUNT; i++) {
        const onScreen = VOICE_BAR_HEIGHTS[i] * voiceBarScale(i, micLevel);
        expect(onScreen).toBeCloseTo(voiceBarHeight(i, micLevel), 10);
      }
    }
  });

  it("never scales a bar past the height it was laid out at", () => {
    for (const micLevel of LEVELS) {
      for (let i = 0; i < VOICE_BAR_COUNT; i++) {
        const scale = voiceBarScale(i, micLevel);
        expect(scale).toBeGreaterThan(0);
        expect(scale).toBeLessThanOrEqual(1);
      }
    }
  });

  // The bars used to breathe on a sine while nothing was being said. Movement
  // that does not mean "the microphone heard something" also hides a meter that
  // has stopped updating, which is the failure this shape is meant to expose.
  it("is perfectly still while nothing is being said", () => {
    for (let i = 0; i < VOICE_BAR_COUNT; i++) {
      const atRest = voiceBarHeight(i, 0);
      // Same answer no matter when it is asked, so the only input is the level.
      for (let call = 0; call < 50; call++) {
        expect(voiceBarHeight(i, 0)).toBe(atRest);
      }
      expect(atRest).toBe(Math.max(2, [2.8, 5.3, 9.0, 6.6, 4.0][i]));
    }
  });

  it("keeps the centre bar the tallest and the level monotonic", () => {
    const heights = VOICE_BAR_HEIGHTS;
    expect(Math.max(...heights)).toBe(heights[2]);

    let previous = -Infinity;
    for (const micLevel of LEVELS) {
      const height = voiceBarHeight(2, micLevel);
      expect(height).toBeGreaterThan(previous);
      previous = height;
    }
  });

  it("holds a floor so a resting bar is still visible", () => {
    for (let i = 0; i < VOICE_BAR_COUNT; i++) {
      expect(voiceBarHeight(i, 0)).toBeGreaterThanOrEqual(2);
    }
  });
});
