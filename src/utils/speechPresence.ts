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
 * Floor under the dynamic bar (~-54 dBFS). Chromium's noise suppression drives
 * the gaps between words to denormal-tiny values rather than to zero, and a
 * median of 1e-12 would otherwise put the bar at 8e-12, where every scrap of
 * suppressed noise reads as speech and nothing is ever silent. Measured: real
 * capture of a lone click reported 47 "loud" frames before this existed.
 */
export const SPEECH_DYNAMIC_MIN_RMS = 0.002;

/**
 * Loud frames needed before a recording counts as speech. Two frames is about
 * 100ms of sound, which a spoken word clears and a single keyboard click or
 * desk knock does not.
 */
export const SPEECH_MIN_FRAMES = 2;

/** Below this many samples there is not enough evidence to call it either way. */
export const SPEECH_MIN_READINGS = 5;

/**
 * RMS of consecutive frames across every channel of a decoded recording: the
 * same kind of reading the live meter takes, taken from the audio that was
 * actually recorded. A trailing partial frame is left out.
 */
export function frameRmsLevels(channels: readonly Float32Array[], frameLength: number): number[] {
  const levels: number[] = [];
  const length = channels[0]?.length ?? 0;
  if (frameLength < 1) {
    return levels;
  }

  for (let start = 0; start + frameLength <= length; start += frameLength) {
    let sumOfSquares = 0;
    for (const channel of channels) {
      for (let i = start; i < start + frameLength; i += 1) {
        sumOfSquares += channel[i] * channel[i];
      }
    }
    levels.push(Math.sqrt(sumOfSquares / (frameLength * channels.length)));
  }
  return levels;
}

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
  // unreachable; a quiet microphone never reaches the absolute one. The bar
  // therefore always lands between SPEECH_DYNAMIC_MIN_RMS and
  // SPEECH_ABSOLUTE_RMS, however loud or quiet the recording's own floor is.
  const dynamicThreshold = Math.max(floorRms * SPEECH_DYNAMIC_RATIO, SPEECH_DYNAMIC_MIN_RMS);
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
