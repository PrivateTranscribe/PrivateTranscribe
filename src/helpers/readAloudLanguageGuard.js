/**
 * Read Aloud non-English guard.
 *
 * Ledger gate `readaloud-nonenglish-guard`: the bundled Kokoro voices are
 * English-phoneme only, so speaking a Danish (or any other non-English)
 * selection produces garbled English-phoneme nonsense instead of failing
 * loudly. This module decides, before synthesis, whether captured text is
 * confidently non-English - if so the caller should show a notice instead of
 * speaking it.
 *
 * `franc-min` was tried first (it's what the spec that produced this file
 * named as the default pick) and rejected: its trigram data only covers ~44
 * Latin-script languages chosen by speaker count, and Danish ('dan') is not
 * among them. Danish text was misclassified as English, Swedish, or Dutch
 * depending on wording - useless for a bug report that is specifically about
 * Danish. `tinyld` (the spec's named fallback) ships Danish and every other
 * language this guard needs to name, so that's what's wired in.
 *
 * Fails open: any error here must result in the text being spoken, not in
 * Read Aloud going silent. A detection library bug is not worth losing the
 * feature over.
 */

const debugLogger = require("./debugLogger");

/**
 * Below this length, tinyld's n-gram statistics are too thin to trust: short
 * strings routinely tie or flip between closely related languages (see the
 * "Hej med dig" case in the unit tests, which splits its vote across Danish,
 * Swedish, and Norwegian). Speaking a short ambiguous string is the safe
 * default - a false block is worse than an occasional mispronounced word.
 */
const MIN_LENGTH = 40;

/**
 * How much of the winning language's score English's own score is allowed to
 * keep before this stops calling it a confident non-English result. Measured
 * against tinyld@1.3.4's detectAll() with the samples that back the unit
 * tests (accuracy is tinyld's own 0..1 n-gram match score, not a probability
 * - it does not have to sum to 1 across languages):
 *
 *   - Clean Danish, 113 chars: da=0.687, en unscored (0)          -> ratio 0
 *   - Danish diluted by an English product name, 174 chars:
 *       da=0.084, en=0.014                                       -> ratio 0.16
 *   - Clean German, 133 chars:  de=1.0,   en unscored (0)         -> ratio 0
 *   - Clean Swedish, 112 chars: sv=1.0,   en unscored (0)         -> ratio 0
 *   - Clean English, 122 chars: en=0.347 (wins the top slot outright)
 *   - Mostly-English text with a couple of loanwords, 117 chars:
 *       en=0.899 (wins the top slot outright)
 *
 * English winning the top slot is handled separately, before this ratio is
 * ever computed. 0.5 sits well above every non-English sample's ratio here
 * (worst case 0.16) while leaving comfortable headroom, so a language that
 * only mildly out-scores English does not get blocked on a coin-flip margin.
 */
const ENGLISH_SCORE_MARGIN = 0.5;

// Loaded once and cached: tinyld is ESM-only, so this module (CommonJS, like
// the rest of the main process) reaches it through a dynamic import, the same
// pattern src/helpers/kokoro.js uses for kokoro-js and @huggingface/transformers.
let tinyldPromise = null;
function loadTinyld() {
  if (!tinyldPromise) {
    tinyldPromise = import("tinyld");
  }
  return tinyldPromise;
}

function capitalize(code) {
  if (!code) return code;
  return code.charAt(0).toUpperCase() + code.slice(1);
}

/**
 * Decide whether `text` is confidently non-English.
 *
 * @param {string} text
 * @returns {Promise<{block: boolean, language?: string, languageName?: string}>}
 */
async function checkReadAloudLanguage(text) {
  try {
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (trimmed.length < MIN_LENGTH) {
      return { block: false };
    }

    const { detectAll, toISO3, langName } = await loadTinyld();
    const results = detectAll(trimmed);
    if (!results || !results.length) {
      return { block: false };
    }

    const top = results[0];
    // tinyld returns an empty lang for text it cannot fingerprint at all, and
    // 'en' winning its own top slot is exactly the case this guard must never
    // block - a false block on English is worse than a mispronounced word.
    if (!top.lang || top.lang === "en") {
      return { block: false };
    }

    const englishEntry = results.find((entry) => entry.lang === "en");
    const englishScore = englishEntry ? englishEntry.accuracy : 0;
    if (englishScore >= top.accuracy * ENGLISH_SCORE_MARGIN) {
      return { block: false };
    }

    const iso3 = toISO3(top.lang) || top.lang;
    const languageName = langName(iso3) || capitalize(top.lang);

    return { block: true, language: top.lang, languageName };
  } catch (error) {
    debugLogger.warn("Read Aloud language guard failed; speaking anyway", {
      error: error?.message,
    });
    return { block: false };
  }
}

module.exports = { checkReadAloudLanguage };
