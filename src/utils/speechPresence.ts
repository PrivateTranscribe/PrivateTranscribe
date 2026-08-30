/**
 * Decide whether a dictation actually contained speech, from microphone levels
 * sampled while it was being recorded.
 *
 * Whisper never answers "nothing was said". Handed silence it invents a short
 * stock phrase instead - "Thank you.", "Bye.", a subtitle credit - and that
 * text gets pasted as if the user had dictated it. The engines cannot be
 * talked out of this, so the recording has to be judged before it is sent.
 *
 * Two tests, either of which counts as speech, because neither survives alone:
 *
 * - An absolute floor catches ordinary dictation. Anything reaching it is
 *   loud enough to be a voice on any microphone.
 * - A level well above the recording's own median catches quiet microphones,
 *   where every frame sits under the absolute floor but speech still stands
 *   out of the room tone by a wide margin.
 *
 * Room tone fails both: it never reaches the absolute floor, and being
 * stationary it never rises far above its own median.
 */

/** Frame level that is speech on any microphone (~-34 dBFS). */
export const SPEECH_ABSOLUTE_RMS = 0.02;

/** How far above the recording's median a quiet microphone's speech must rise. */
export const SPEECH_DYNAMIC_RATIO = 8;

/**
 * Loud frames needed before a recording counts as speech. Two frames is about
 * 100ms of sound, which a spoken word clears and a single keyboard click or
 * desk knock does not.
 */
export const SPEECH_MIN_FRAMES = 2;

/** Below this many samples there is not enough evidence to call it either way. */
export const SPEECH_MIN_READINGS = 5;

export interface SpeechLevelSummary {
  /** False when the microphone level was never readable - never treated as silence. */
  measured: boolean;
  speechDetected: boolean;
  readings: number;
  peakRms: number;
  floorRms: number;
  loudFrames: number;
}

/**
 * @param levels RMS readings taken at a fixed interval across the recording.
 */
export function summarizeSpeechLevels(levels: readonly number[] = []): SpeechLevelSummary {
  const usable = levels.filter((level) => Number.isFinite(level) && level >= 0);

  // An unreadable microphone is not a silent one. Saying "speech" here keeps a
  // real dictation from being thrown away because Web Audio was unavailable.
  if (usable.length < SPEECH_MIN_READINGS) {
    return {
      measured: false,
      speechDetected: true,
      readings: usable.length,
      peakRms: 0,
      floorRms: 0,
      loudFrames: 0,
    };
  }

  const sorted = [...usable].sort((a, b) => a - b);
  const peakRms = sorted[sorted.length - 1];
  const floorRms = sorted[Math.floor(sorted.length / 2)];

  // The lower of the two bars, so clearing either one counts. A recording that
  // is mostly speech has a high median, which would make the dynamic bar
  // unreachable; a quiet microphone never reaches the absolute one.
  const dynamicThreshold = floorRms > 0 ? floorRms * SPEECH_DYNAMIC_RATIO : Infinity;
  const threshold = Math.min(SPEECH_ABSOLUTE_RMS, dynamicThreshold);
  const loudFrames = usable.filter((level) => level >= threshold).length;

  return {
    measured: true,
    speechDetected: loudFrames >= SPEECH_MIN_FRAMES,
    readings: usable.length,
    peakRms,
    floorRms,
    loudFrames,
  };
}
