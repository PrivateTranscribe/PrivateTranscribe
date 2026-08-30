/**
 * Recognise a transcript that is not something the user said.
 *
 * Whisper cannot answer "nothing was spoken". Given breath, a fan, keyboard
 * noise or an open microphone in a quiet room, it returns one of a few things
 * it was trained on from subtitle tracks: an annotation ("[Music]", "[BANG]"),
 * a credit line ("Subtitles by the Amara.org community"), or a stock phrase
 * off the end of a video ("Thank you.", "Thanks for watching!", "You").
 *
 * Measured on this repo's own pipeline: 8 seconds of faint breath produced
 * "Thank you." with no_speech_prob 0.00 and avg_logprob -0.03, while real
 * speech through the same path scored no_speech_prob 0.56. The engine is more
 * confident in the invention than in the truth, so no decode threshold
 * separates them and no microphone level does either - faint breath and quiet
 * speech sit at the same amplitude. The text itself is the only signal left.
 *
 * The rules below need different amounts of evidence because they carry
 * different risks. Nobody dictates an annotation or a subtitle credit, so
 * those are dropped on sight. A short stock phrase IS something a person might
 * say, so that needs the recording's length to corroborate it.
 */

/** Whisper's own subtitle annotations. */
const ANNOTATION_ONLY = /^[([][^)\]]*[)\]]$/;

/** No letter or digit anywhere - a transcript of ".", "..." or "-". */
const NO_WORDS = /^[^\p{L}\p{N}]+$/u;

/**
 * Subtitle credits. These are unmistakable: the phrasing only exists because
 * the training data ended with it, and no dictation produces one. Matched
 * against the whole transcript, so a sentence that merely mentions subtitles
 * is untouched.
 */
const CREDIT_LINES: RegExp[] = [
  /^subtitle(s|d)?\s+(by|from|provided by)\b/,
  /^subs?\s+by\b/,
  /^transcription\s+by\b/,
  /^caption(s|ing|ed)?\s+by\b/,
  /amara\.org/,
  /^sous-titres\b/,
  /^untertitel\b/,
  /^tekstet av\b/,
  /^undertekster af\b/,
  /^字幕/,
];

/**
 * Phrases whisper emits in place of silence.
 *
 * Dropping one costs a user who really did dictate exactly these words, so the
 * list stays short, is only ever applied to a transcript that is nothing else,
 * and only when the recording was too long to plausibly contain only them.
 * Danish sits alongside English because dictation here is not English-only.
 */
const STOCK_PHRASES = new Set([
  // English
  "you",
  "so",
  "okay",
  "thanks",
  "thank you",
  "thank you very much",
  "thank you so much",
  "thanks a lot",
  "thanks for watching",
  "thank you for watching",
  "please subscribe",
  "subscribe to my channel",
  "bye",
  "bye bye",
  "goodbye",
  // Danish
  "tak",
  "mange tak",
  "tak for det",
  "tak fordi du så med",
  "farvel",
]);

/**
 * A recording longer than this that produced nothing but a stock phrase was
 * not a person saying that phrase. Someone dictating "thank you" is done in
 * about a second; the rest is silence whisper filled in. Four seconds leaves
 * generous room for a slow start and a late hotkey release.
 */
export const STOCK_PHRASE_MIN_DURATION_SECONDS = 4;

/** Strip the punctuation and casing that separate "Thank you." from "thank you". */
const normalize = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/^["'“”‘’\-–—\s]+/, "")
    .replace(/[.!?,;:…"'“”‘’\-–—\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim();

export interface NonSpeechArtifactCheck {
  isArtifact: boolean;
  /** Which rule fired, for the log line that explains a dropped dictation. */
  reason: "annotation" | "no-words" | "subtitle-credit" | "stock-phrase" | null;
}

const NOT_AN_ARTIFACT: NonSpeechArtifactCheck = { isArtifact: false, reason: null };

export function classifyNonSpeechArtifact(
  text: string | null | undefined,
  { durationSeconds }: { durationSeconds?: number | null } = {}
): NonSpeechArtifactCheck {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return NOT_AN_ARTIFACT;

  // None of these three is ever dictation, whatever the recording's length, so
  // they need no corroboration.
  if (ANNOTATION_ONLY.test(trimmed)) {
    return { isArtifact: true, reason: "annotation" };
  }
  if (NO_WORDS.test(trimmed)) {
    return { isArtifact: true, reason: "no-words" };
  }

  const normalized = normalize(trimmed);
  if (CREDIT_LINES.some((pattern) => pattern.test(normalized))) {
    return { isArtifact: true, reason: "subtitle-credit" };
  }

  if (
    STOCK_PHRASES.has(normalized) &&
    typeof durationSeconds === "number" &&
    durationSeconds >= STOCK_PHRASE_MIN_DURATION_SECONDS
  ) {
    return { isArtifact: true, reason: "stock-phrase" };
  }

  return NOT_AN_ARTIFACT;
}
