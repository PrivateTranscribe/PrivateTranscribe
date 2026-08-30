/**
 * Recognise a transcript that is not something the user said.
 *
 * Whisper cannot answer "nothing was spoken". Given breath, a fan, keyboard
 * noise or an open microphone in a quiet room, it returns one of two things:
 *
 *   - an annotation it was trained on from subtitles - "[Music]", "[BANG]",
 *     "(wind blowing)" - which the app pastes verbatim today;
 *   - a stock phrase off the end of a subtitle track - "Thank you.", "Thanks
 *     for watching!", "You".
 *
 * Measured on this repo's own pipeline: 8 seconds of faint breath produced
 * "Thank you." with no_speech_prob 0.00 and avg_logprob -0.03, while real
 * speech through the same path scored no_speech_prob 0.56. The engine is more
 * confident in the invention than in the truth, so no decode threshold
 * separates them and no microphone level does either - faint breath and quiet
 * speech sit at the same amplitude. The text itself is the only signal left.
 *
 * The two rules are deliberately unequal in how much evidence they need,
 * because they carry different risks.
 */

/** Whisper's own subtitle annotations. Nobody dictates these. */
const ANNOTATION_ONLY = /^[([\[][^)\]]*[)\]]$/;

/**
 * Phrases whisper emits in place of silence. Dropping one costs a user who
 * really did dictate just these words, so this list stays short and is only
 * ever applied to a transcript that is nothing else, and only when the
 * recording was too long to plausibly contain only them.
 */
const STOCK_PHRASES = new Set([
  "you",
  "thank you",
  "thanks",
  "thank you very much",
  "thanks for watching",
  "thank you for watching",
  "thanks for watching!",
  "please subscribe",
  "bye",
  "bye bye",
  "okay",
  "so",
]);

/**
 * A recording longer than this that produced nothing but a stock phrase was
 * not a person saying that phrase. Someone dictating "thank you" is done in
 * about a second; the surrounding silence is what whisper filled in.
 */
export const STOCK_PHRASE_MIN_DURATION_SECONDS = 4;

/** Strip the punctuation and casing that separate "Thank you." from "thank you". */
const normalize = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:…]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

export interface NonSpeechArtifactCheck {
  isArtifact: boolean;
  /** Which rule fired, for the log line that explains a dropped dictation. */
  reason: "annotation" | "stock-phrase" | null;
}

export function classifyNonSpeechArtifact(
  text: string | null | undefined,
  { durationSeconds }: { durationSeconds?: number | null } = {}
): NonSpeechArtifactCheck {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { isArtifact: false, reason: null };

  // An annotation is never dictation, whatever the recording's length, so this
  // rule needs no corroboration.
  if (ANNOTATION_ONLY.test(trimmed)) {
    return { isArtifact: true, reason: "annotation" };
  }

  if (
    STOCK_PHRASES.has(normalize(trimmed)) &&
    typeof durationSeconds === "number" &&
    durationSeconds >= STOCK_PHRASE_MIN_DURATION_SECONDS
  ) {
    return { isArtifact: true, reason: "stock-phrase" };
  }

  return { isArtifact: false, reason: null };
}
