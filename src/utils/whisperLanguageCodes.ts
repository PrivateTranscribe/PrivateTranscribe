/**
 * whisperLanguageCodes.ts
 *
 * Every language code whisper.cpp accepts on its `language` parameter — the
 * engine's own ~99, not the 58 the UI picker offers.
 *
 * Why a second copy of this list exists: the main process reads the same set
 * out of `src/helpers/whisperLanguage.js` (CommonJS, name → code), which the
 * renderer bundle cannot import. The two are pinned together by
 * `tests/unit/utils/whisperLanguageCodes.test.ts`, which fails the moment one
 * gains or loses a code the other does not have.
 *
 * This is a validation list, deliberately wider than the picker: rejecting
 * everything the picker omits would refuse languages whisper really handles,
 * and rejecting nothing lets a stale code kill whisper-server (audit F3).
 */

export const WHISPER_LANGUAGE_CODES: readonly string[] = [
  "af",
  "sq",
  "am",
  "ar",
  "hy",
  "as",
  "az",
  "ba",
  "eu",
  "be",
  "bn",
  "bs",
  "br",
  "bg",
  "my",
  "yue",
  "ca",
  "zh",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "et",
  "fo",
  "fi",
  "fr",
  "gl",
  "ka",
  "de",
  "el",
  "gu",
  "ht",
  "ha",
  "haw",
  "he",
  "hi",
  "hu",
  "is",
  "id",
  "it",
  "ja",
  "jw",
  "kn",
  "kk",
  "km",
  "ko",
  "lo",
  "la",
  "lv",
  "ln",
  "lt",
  "lb",
  "mk",
  "mg",
  "ms",
  "ml",
  "mt",
  "mi",
  "mr",
  "mn",
  "ne",
  "no",
  "nn",
  "oc",
  "ps",
  "fa",
  "pl",
  "pt",
  "pa",
  "ro",
  "ru",
  "sa",
  "sr",
  "sn",
  "sd",
  "si",
  "sk",
  "sl",
  "so",
  "es",
  "su",
  "sw",
  "sv",
  "tl",
  "tg",
  "ta",
  "tt",
  "te",
  "th",
  "bo",
  "tr",
  "tk",
  "uk",
  "ur",
  "uz",
  "vi",
  "cy",
  "yi",
  "yo",
];

const WHISPER_LANGUAGE_CODE_SET = new Set(WHISPER_LANGUAGE_CODES);

/** True when whisper.cpp would accept this code. "auto" is not a code. */
export function isWhisperLanguageCode(language: string): boolean {
  if (typeof language !== "string") return false;
  return WHISPER_LANGUAGE_CODE_SET.has(language.trim().toLowerCase());
}
