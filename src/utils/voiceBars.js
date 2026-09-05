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

// Resting heights derived from the logo proportions (tallest bar = 9px). The
// bars hold this shape exactly whenever nothing is being said. They used to
// breathe on a sine, which is decorative motion during a dictation and reads as
// the meter having heard something. It also hid a stuck meter, because a row of
// bars that always moves a little looks the same broken as working.
const BAR_RESTING_HEIGHTS = [2.8, 5.3, 9.0, 6.6, 4.0];

// The centre bar grows most, the outer bars least.
const BAR_GROWTH_FACTORS = [8, 11, 16, 12, 9];

const BAR_MIN_HEIGHT = 2;

export const VOICE_BAR_COUNT = BAR_RESTING_HEIGHTS.length;

/** The laid-out height of each bar, which never changes. */
export const VOICE_BAR_HEIGHTS = BAR_RESTING_HEIGHTS.map(
  (resting, index) => resting + BAR_GROWTH_FACTORS[index]
);

/**
 * The height a bar should appear to have, in CSS pixels. A function of the
 * level alone, so movement always means the microphone heard something.
 */
export function voiceBarHeight(index, micLevel) {
  const driven = micLevel * BAR_GROWTH_FACTORS[index];
  return Math.max(BAR_MIN_HEIGHT, BAR_RESTING_HEIGHTS[index] + driven);
}

/** The same height expressed as a vertical scale of the laid-out bar. */
export function voiceBarScale(index, micLevel) {
  return voiceBarHeight(index, micLevel) / VOICE_BAR_HEIGHTS[index];
}
