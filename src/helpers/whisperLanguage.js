/**
 * whisperLanguage.js
 *
 * whisper.cpp reports the language it detected as a full lowercase English
 * name ("danish"), but every place we can *send* a language back expects an
 * ISO code ("da"). This module is the translation layer between the two, and
 * the gatekeeper that decides whether a detection is trustworthy enough to
 * reuse.
 *
 * Main-process only (CommonJS). The renderer never needs this table: it
 * receives an already-normalised code and echoes it back as an opaque token.
 */

// Whisper's own language set. Keyed by the full name whisper.cpp emits, valued
// by the ISO code its `language` request parameter accepts. Deliberately not
// derived from src/utils/languages.ts — that list is the UI picker (a curated
// subset) and shrinking this one to match it would silently disable locking
// for every language the picker omits.
const WHISPER_NAME_TO_CODE = {
  afrikaans: "af",
  albanian: "sq",
  amharic: "am",
  arabic: "ar",
  armenian: "hy",
  assamese: "as",
  azerbaijani: "az",
  bashkir: "ba",
  basque: "eu",
  belarusian: "be",
  bengali: "bn",
  bosnian: "bs",
  breton: "br",
  bulgarian: "bg",
  burmese: "my",
  cantonese: "yue",
  catalan: "ca",
  chinese: "zh",
  croatian: "hr",
  czech: "cs",
  danish: "da",
  dutch: "nl",
  english: "en",
  estonian: "et",
  faroese: "fo",
  finnish: "fi",
  french: "fr",
  galician: "gl",
  georgian: "ka",
  german: "de",
  greek: "el",
  gujarati: "gu",
  "haitian creole": "ht",
  hausa: "ha",
  hawaiian: "haw",
  hebrew: "he",
  hindi: "hi",
  hungarian: "hu",
  icelandic: "is",
  indonesian: "id",
  italian: "it",
  japanese: "ja",
  javanese: "jw",
  kannada: "kn",
  kazakh: "kk",
  khmer: "km",
  korean: "ko",
  lao: "lo",
  latin: "la",
  latvian: "lv",
  lingala: "ln",
  lithuanian: "lt",
  luxembourgish: "lb",
  macedonian: "mk",
  malagasy: "mg",
  malay: "ms",
  malayalam: "ml",
  maltese: "mt",
  maori: "mi",
  marathi: "mr",
  mongolian: "mn",
  myanmar: "my",
  nepali: "ne",
  norwegian: "no",
  nynorsk: "nn",
  occitan: "oc",
  pashto: "ps",
  persian: "fa",
  polish: "pl",
  portuguese: "pt",
  punjabi: "pa",
  romanian: "ro",
  russian: "ru",
  sanskrit: "sa",
  serbian: "sr",
  shona: "sn",
  sindhi: "sd",
  sinhala: "si",
  slovak: "sk",
  slovenian: "sl",
  somali: "so",
  spanish: "es",
  sundanese: "su",
  swahili: "sw",
  swedish: "sv",
  tagalog: "tl",
  tajik: "tg",
  tamil: "ta",
  tatar: "tt",
  telugu: "te",
  thai: "th",
  tibetan: "bo",
  turkish: "tr",
  turkmen: "tk",
  ukrainian: "uk",
  urdu: "ur",
  uzbek: "uz",
  vietnamese: "vi",
  welsh: "cy",
  yiddish: "yi",
  yoruba: "yo",
};

const WHISPER_CODES = new Set(Object.values(WHISPER_NAME_TO_CODE));

// whisper.cpp emits this when it transcribed silence. Locking the session
// language off a silent segment is exactly the failure mode we are fixing,
// so it has to count as "no usable text".
const BLANK_AUDIO_PATTERN = /^\[\s*blank_audio\s*\]$/i;

/**
 * Normalises whatever whisper.cpp put in the `language` field into an ISO code
 * we can send back on later requests.
 *
 * Accepts both shapes the server has used across builds: the full name
 * ("danish") and the bare code ("da"). Returns null for anything unrecognised,
 * empty, or "auto" — callers treat null as "no lock, keep auto-detecting".
 */
function normalizeWhisperLanguage(value) {
  if (typeof value !== "string") return null;

  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "auto") return null;

  if (WHISPER_CODES.has(normalized)) return normalized;

  return WHISPER_NAME_TO_CODE[normalized] || null;
}

/**
 * True when a transcription result carries real speech.
 *
 * Language detection on a segment of silence or noise is a coin flip, and a
 * bad flip would poison every later segment once locked. Requiring actual text
 * is the cheap stand-in for the confidence threshold faster-whisper exposes
 * and whisper.cpp does not.
 */
function hasUsableSpeech(result) {
  const text = typeof result?.text === "string" ? result.text.trim() : "";
  if (!text) return false;
  return !BLANK_AUDIO_PATTERN.test(text);
}

/**
 * Decides the language to lock for the rest of a recording, given one result.
 *
 * Returns null unless the segment both produced speech and reported a language
 * we recognise, so an unusable segment simply defers the decision to the next
 * one instead of committing to a guess.
 */
function resolveLockableLanguage(result) {
  if (!hasUsableSpeech(result)) return null;
  return normalizeWhisperLanguage(result?.language ?? result?.detectedLanguage);
}

/**
 * How much of the winning language's probability an allowed language has to
 * hold before we override Whisper's own answer.
 *
 * The case this exists for is Danish losing to Norwegian: the two split the
 * distribution almost evenly, so the allowed one always clears a tenth of the
 * winner and the snap fires. The case it exists to *prevent* is a user with
 * Danish and English selected saying one sentence in German — German wins
 * outright, Danish and English sit near zero, and forcing the audio into a
 * language nobody spoke would produce word salad. Below the floor we keep
 * Whisper's answer and let the transcript be honest about what was said.
 */
const LANGUAGE_SNAP_MIN_SHARE = 0.1;

/**
 * Normalises a caller-supplied allowlist into Whisper codes.
 *
 * Anything Whisper cannot be asked for is dropped rather than passed through,
 * so a stale or hand-edited setting degrades to "no constraint" instead of
 * pinning every recording to a language the decoder will reject.
 */
function normalizeAllowedLanguages(allowedLanguages) {
  if (!Array.isArray(allowedLanguages)) return [];

  const seen = new Set();
  for (const entry of allowedLanguages) {
    const code = normalizeWhisperLanguage(entry);
    if (code) seen.add(code);
  }
  return [...seen];
}

/**
 * Decides which language a result *should* have been decoded as, given the
 * languages the speaker actually speaks.
 *
 * whisper.cpp returns a full probability distribution alongside its own pick
 * (`language_probabilities`, keyed by ISO code), so restricting the argmax to
 * the allowed set needs no second detection pass — the numbers to choose from
 * are already in the response we have.
 *
 * Returns null when there is nothing to do: no allowlist, no usable speech,
 * Whisper already picked an allowed language, or no allowed language holds
 * enough probability to justify overruling it. A non-null result carries
 * `changed`, which tells the caller whether the audio still has to be decoded
 * again to actually benefit.
 */
function resolveAllowedLanguage(result, allowedLanguages) {
  const allowed = normalizeAllowedLanguages(allowedLanguages);
  if (allowed.length === 0) return null;
  if (!hasUsableSpeech(result)) return null;

  const detected = normalizeWhisperLanguage(
    result?.language ?? result?.detected_language ?? result?.detectedLanguage
  );
  if (detected && allowed.includes(detected)) {
    return { language: detected, changed: false, reason: "detected-allowed" };
  }

  const probabilities =
    result && typeof result.language_probabilities === "object" && result.language_probabilities
      ? result.language_probabilities
      : null;

  if (!probabilities) {
    // Older whisper.cpp builds, and the `--no-language-probabilities` server
    // flag, both leave us with a bare winner. With a single allowed language
    // there is still only one answer worth giving; with several there is no
    // basis to choose between them, so leave the detection alone.
    if (allowed.length === 1) {
      return { language: allowed[0], changed: true, reason: "single-allowed-no-probabilities" };
    }
    return null;
  }

  let bestAllowed = null;
  let bestAllowedProbability = 0;
  let bestOverallProbability = 0;

  for (const [code, probability] of Object.entries(probabilities)) {
    if (typeof probability !== "number" || !Number.isFinite(probability)) continue;
    if (probability > bestOverallProbability) bestOverallProbability = probability;

    const normalized = normalizeWhisperLanguage(code);
    if (!normalized || !allowed.includes(normalized)) continue;
    if (probability > bestAllowedProbability) {
      bestAllowedProbability = probability;
      bestAllowed = normalized;
    }
  }

  if (!bestAllowed) return null;
  if (bestOverallProbability <= 0) return null;
  if (bestAllowedProbability < bestOverallProbability * LANGUAGE_SNAP_MIN_SHARE) return null;

  return {
    language: bestAllowed,
    changed: bestAllowed !== detected,
    reason: "snapped-to-allowed",
    probability: bestAllowedProbability,
    detectedProbability: bestOverallProbability,
  };
}

module.exports = {
  LANGUAGE_SNAP_MIN_SHARE,
  normalizeAllowedLanguages,
  resolveAllowedLanguage,
  normalizeWhisperLanguage,
  hasUsableSpeech,
  resolveLockableLanguage,
  WHISPER_NAME_TO_CODE,
};
