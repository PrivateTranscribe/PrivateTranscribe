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

module.exports = {
  normalizeWhisperLanguage,
  hasUsableSpeech,
  resolveLockableLanguage,
  WHISPER_NAME_TO_CODE,
};
