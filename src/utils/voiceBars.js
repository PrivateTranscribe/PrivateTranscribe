/**
 * Geometry for the five level bars inside the dictation button.
 *
 * Each bar is laid out once at its tallest and scaled down, so the only thing
 * that changes from frame to frame is a transform. Height is a layout property,
 * and after a display sleep or a GPU context loss Chromium can carry on
 * compositing transform and opacity while painted geometry stays stale. That is
 * what left the bars stuck while the halo beside them, which is driven by
 * transform and opacity, kept swelling with the voice. The two read the same
 * `micLevel` from the same render, so they can only ever disagree below React.
 * Sharing the halo's mechanism removes that gap.
 */

// Phase offsets so the bars do not breathe in unison at low levels.
const BAR_PHASES = [0, Math.PI * 0.5, Math.PI * 0.9, Math.PI * 0.4, Math.PI * 0.7];

// Resting heights derived from the logo proportions (tallest bar = 9px).
const BAR_RESTING_HEIGHTS = [2.8, 5.3, 9.0, 6.6, 4.0];

// The centre bar grows most, the outer bars least.
const BAR_GROWTH_FACTORS = [8, 11, 16, 12, 9];

const BAR_BREATHING_AMPLITUDE = 0.8;
const BAR_MIN_HEIGHT = 2;

export const VOICE_BAR_COUNT = BAR_PHASES.length;

/** The laid-out height of each bar, which never changes. */
export const VOICE_BAR_HEIGHTS = BAR_RESTING_HEIGHTS.map(
  (resting, index) => resting + BAR_BREATHING_AMPLITUDE + BAR_GROWTH_FACTORS[index]
);

/** The height a bar should appear to have, in CSS pixels. */
export function voiceBarHeight(index, micLevel, nowMs) {
  const breathing =
    Math.sin((nowMs / 1000) * 1.2 * Math.PI + BAR_PHASES[index]) * BAR_BREATHING_AMPLITUDE;
  const driven = micLevel * BAR_GROWTH_FACTORS[index];
  return Math.max(BAR_MIN_HEIGHT, BAR_RESTING_HEIGHTS[index] + breathing + driven);
}

/** The same height expressed as a vertical scale of the laid-out bar. */
export function voiceBarScale(index, micLevel, nowMs) {
  return voiceBarHeight(index, micLevel, nowMs) / VOICE_BAR_HEIGHTS[index];
}
