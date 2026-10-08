"use strict";

/**
 * Parakeet writes hesitations down word for word ("it uh crashes"), while
 * Whisper leaves them out, so plain Parakeet dictation read worse than Whisper's
 * even with fewer real mistakes. Only pure hesitation sounds are removed: "er"
 * stays because it is the Danish verb "is", and "ah"/"oh" can carry meaning.
 */
const FILLER = "(uh+|u+h?m+|erm|hm+|mm+|øh+m*|æh+m*)";

// "um" is a word in these: German "around", Portuguese "a", Croatian and
// Slovenian "mind". It is removed only when every language spoken is known
// and none of them is one of these.
const UM_IS_A_WORD = new Set(["de", "pt", "hr", "sl"]);

// "Uh, so I" at the start of a sentence: drop it and capitalise what follows.
const SENTENCE_START = new RegExp(`(^|[.!?]\\s+)${FILLER}[,.…]*\\s+(\\p{L})(?=(\\S*))`, "giu");
// Anywhere else, as a whole word. A full stop after it still ends the sentence.
const INLINE = new RegExp(`(^|\\s)${FILLER}[,…]*(?=\\s|$|[.!?;:)"'])`, "giu");

// Marks where an inline filler was cut, so the clean-up touches only those spots.
const CUT = "\u0000";

function baseLanguage(code) {
  return typeof code === "string" ? code.trim().toLowerCase().split(/[-_]/)[0] : "";
}

function umIsFiller(languages) {
  const codes = (Array.isArray(languages) ? languages : []).map(baseLanguage).filter(Boolean);
  return codes.length > 0 && codes.every((code) => !UM_IS_A_WORD.has(code));
}

function keepsWord(word, before, removeUm) {
  // An acronym such as "ERM" is a word, not a hesitation.
  if (word.length > 1 && word === word.toUpperCase()) return true;
  if (!removeUm && word.toLowerCase() === "um") return true;
  // "12 mm" is a unit.
  return /^mm$/i.test(word) && /\d\s*$/.test(before);
}

function tidyCuts(text) {
  return text
    .replace(new RegExp(`,\\s*(?:${CUT}\\s*)+(?=[.!?…]|$)`, "g"), "")
    .replace(new RegExp(`\\s*(?:${CUT}\\s*)+(?=[,.!?;:…)"']|$)`, "g"), "")
    .replace(new RegExp(`^\\s*(?:${CUT}\\s*)+`), "")
    .replace(new RegExp(`\\s*(?:${CUT}\\s*)+`, "g"), " ")
    .trim();
}

/**
 * @param {string} text
 * @param {{ languages?: string[] }} [options] the languages the user speaks
 */
function removeFillerWords(text, { languages } = {}) {
  if (typeof text !== "string" || !text) return text;
  const removeUm = umIsFiller(languages);

  let result = text;
  let previous;
  do {
    previous = result;
    result = result.replace(SENTENCE_START, (match, lead, word, letter, rest, offset, whole) => {
      const before = whole.slice(0, offset);
      if (keepsWord(word, before, removeUm)) return match;
      // "e.g. um the docs" does not start a sentence, and "iPhone" keeps its case.
      const abbreviation = /(?:^|[\s(])\p{L}(?:\.\p{L})+$/u.test(before);
      const ownCase = /\p{Lu}/u.test(rest);
      return `${lead}${abbreviation || ownCase ? letter : letter.toUpperCase()}`;
    });
  } while (result !== previous);

  result = result.replace(INLINE, (match, lead, word, offset, whole) =>
    keepsWord(word, whole.slice(0, offset), removeUm) ? match : `${lead}${CUT}`
  );
  if (result === text) return text;
  if (result.includes(CUT)) result = tidyCuts(result);

  // A recording of nothing but "Uh." is no speech, as Whisper reports it.
  return /[\p{L}\p{N}]/u.test(result) ? result : "";
}

module.exports = { removeFillerWords };
