"use strict";

/**
 * Matches a spoken answer to one of a question's own option labels. Pure.
 *
 * Only a label can come out, never the words that were heard: speech
 * recognition can invent words, and an answer that reaches a chat must be one
 * the chat offered. A label wins when the answer carries its words, and
 * clearly more of them than any other label's. Anything less is no answer.
 * An answer with a "no" in it can only pick a label that says no itself, so
 * "don't merge it" never comes out as Merge it.
 *
 *   "uh, merge it"           [Merge it, Not now]            → Merge it
 *   "fix one"                [Yes, fix 1, Yes, fix 2]       → Yes, fix 1
 *   "yes fix"                [Yes, fix 1, Yes, fix 2]       → none: both fit as well
 *   "thank you"              [Merge it, Not now]            → none
 *   "don't merge it"         [Merge it, Not now]            → none: it says the opposite
 *   "no, not now"            [Merge it, Not now]            → Not now
 */

/** Spoken numbers, so "fix one" and "Fix 1" are the same words. */
const NUMBER_WORDS = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
};

/** Sounds and padding around an answer, dropped unless a label uses the word. */
const FILLERS = new Set([
  "uh",
  "uhm",
  "um",
  "umm",
  "eh",
  "ehm",
  "er",
  "erm",
  "hmm",
  "mm",
  "øh",
  "øhm",
  "please",
  "okay",
  "ok",
  "so",
  "well",
  "the",
  "option",
  "lets",
  "go",
  "with",
]);

/** Words that turn an answer around, apostrophes already dropped ("don't" is "dont"). */
const NEGATIONS = new Set([
  "no",
  "not",
  "nope",
  "nah",
  "never",
  "neither",
  "nor",
  "dont",
  "doesnt",
  "didnt",
  "cant",
  "cannot",
  "wont",
  "shouldnt",
  "isnt",
  "arent",
  "wasnt",
  "werent",
  "nej",
  "ikke",
  "ik",
  "aldrig",
]);

/** The least a label must score, and how far ahead of the next it must be. */
const MIN_SCORE = 0.6;
const MIN_MARGIN = 0.15;
/** An answer is a few words; longer speech is talk, not a pick. */
const MAX_ANSWER_WORDS = 12;

function words(text) {
  if (typeof text !== "string") return [];
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => NUMBER_WORDS[word] || word);
}

/**
 * How well the answer carries a label's words, weighting the label's words
 * found (recall) above extra words said (precision): F2 over word sets.
 */
function score(answer, label) {
  const said = new Set(answer);
  const offered = new Set(label);
  let shared = 0;
  for (const word of offered) if (said.has(word)) shared += 1;
  if (shared === 0) return 0;
  const precision = shared / said.size;
  const recall = shared / offered.size;
  return (5 * precision * recall) / (4 * precision + recall);
}

/**
 * @param {string} text   what speech recognition heard
 * @param {string[]} options   the question's own labels
 * @returns {{label: string, index: number, score: number} | null}
 */
function matchAnswer(text, options) {
  if (!Array.isArray(options) || options.length === 0) return null;
  const labels = options.map((option) => words(option));
  const labelWords = new Set(labels.flat());
  const answer = words(text).filter((word) => !FILLERS.has(word) || labelWords.has(word));
  if (answer.length === 0 || answer.length > MAX_ANSWER_WORDS) return null;
  const negated = answer.some((word) => NEGATIONS.has(word));

  const ranked = labels
    .map((label, index) => {
      // "don't merge it" carries Merge it's words and means the opposite.
      const fits = label.length > 0 && (!negated || label.some((word) => NEGATIONS.has(word)));
      return { index, score: fits ? score(answer, label) : 0 };
    })
    .sort((a, b) => b.score - a.score);
  const [best, next] = ranked;
  if (best.score < MIN_SCORE) return null;
  if (next && best.score - next.score < MIN_MARGIN) return null;
  return { label: options[best.index], index: best.index, score: best.score };
}

module.exports = { matchAnswer, words, MIN_SCORE, MIN_MARGIN, MAX_ANSWER_WORDS };
