/**
 * languageMismatch.ts
 *
 * Decides when to tell the user that the engine heard a different language from
 * the one they picked.
 *
 * The rule is deliberately narrow. Whisper transliterating English audio into
 * Danish because it was told to is expected model behaviour, not a bug — the
 * defect was that the app already had whisper-server's own verdict
 * (`detected_language: "english"` at 0.9965) and threw it away, so a confident
 * page said "Transcription complete" over nonsense (audit F5).
 *
 * So: surface, never override. A forced language stays forced; the notice only
 * offers a one-click re-run, and only when the engine is sure enough that a
 * warning is worth the interruption.
 */

import { getLanguageLabel } from "./languages";

/** whisper-server's own verdict, as it reaches the renderer. */
export type LanguageDetection = {
  detected?: string | null;
  detectedName?: string | null;
  probability?: number | null;
  requested?: string | null;
  mismatch?: boolean;
} | null;

/**
 * How sure the engine has to be before a mismatch is worth showing.
 *
 * Language detection on short or noisy audio is a coin flip, and a notice that
 * fires on a coin flip trains the user to ignore it. The measured case that
 * matters sat at 0.9965.
 */
export const LANGUAGE_MISMATCH_MIN_PROBABILITY = 0.9;

export type LanguageMismatchNotice = {
  /** ISO code the engine says it heard. */
  detected: string;
  detectedLabel: string;
  /** ISO code the user forced. */
  forced: string;
  forcedLabel: string;
  probability: number;
  /** Already rounded for display, e.g. "99.6". */
  probabilityPercent: string;
};

/**
 * Returns the notice to show, or null when there is nothing honest to say.
 *
 * Null covers every ordinary case: auto-detect runs (nothing was forced),
 * agreement, a build that reported no detection, and a detection the engine
 * was not confident about.
 */
export function buildLanguageMismatchNotice(
  detection: LanguageDetection,
  requestedLanguage?: string | null
): LanguageMismatchNotice | null {
  if (!detection) return null;

  const forced =
    detection.requested ||
    (requestedLanguage && requestedLanguage !== "auto" ? requestedLanguage : null);
  if (!forced) return null;

  const detected = detection.detected;
  if (!detected || detected === forced) return null;

  const probability = typeof detection.probability === "number" ? detection.probability : null;
  if (probability === null || !Number.isFinite(probability)) return null;
  if (probability < LANGUAGE_MISMATCH_MIN_PROBABILITY) return null;

  return {
    detected,
    detectedLabel: getLanguageLabel(detected),
    forced,
    forcedLabel: getLanguageLabel(forced),
    probability,
    probabilityPercent: (Math.round(probability * 1000) / 10).toFixed(1),
  };
}
