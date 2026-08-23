/**
 * accuracy-regression.js
 *
 * Pure comparison logic for the transcription accuracy gate. Kept apart from
 * the runner so it can be unit-tested without downloading a dataset or
 * loading a model: the gate deciding what counts as a regression is exactly
 * the part that must not be wrong.
 */

const DEFAULT_MODE = "pinned";

/**
 * Key a measurement by what it measured, so entries survive reordering.
 *
 * Mode is part of the identity because the same model and language score
 * differently with the language pinned than with it detected, and treating
 * those as one number would let a detection regression hide behind a pinned
 * measurement. Entries written before modes existed carry no mode and are
 * read as `pinned`, which is what they were.
 */
function entryKey(language, model, mode = DEFAULT_MODE) {
  return `${language}/${model}/${mode || DEFAULT_MODE}`;
}

const identify = (entry) => ({
  language: entry.language,
  model: entry.model,
  mode: entry.mode || DEFAULT_MODE,
});

/**
 * Compares a benchmark run against a stored baseline.
 *
 * A regression is an increase in WER beyond `tolerancePoints` (absolute
 * percentage points). Improvements never fail; they are reported so the
 * baseline can be refreshed deliberately rather than drifting on its own.
 *
 * Entries in the baseline with no matching result are reported as `missing`
 * and treated as failures. A gate that silently passes when a measurement
 * disappears is how coverage rots: dropping a language would look like
 * success.
 *
 * Results with no baseline entry are reported as `unbaselined`. They do not
 * fail, because a newly added language or mode cannot regress against
 * nothing, but they are surfaced so nobody assumes they are being watched.
 */
function compareToBaseline(results, baseline, { tolerancePoints = 1.5 } = {}) {
  const resultMap = new Map();
  for (const entry of results) {
    resultMap.set(entryKey(entry.language, entry.model, entry.mode), entry);
  }

  const baselineMap = new Map();
  for (const entry of baseline) {
    baselineMap.set(entryKey(entry.language, entry.model, entry.mode), entry);
  }

  const regressions = [];
  const improvements = [];
  const missing = [];
  const unbaselined = [];

  for (const [key, expected] of baselineMap) {
    const actual = resultMap.get(key);
    if (!actual) {
      missing.push(identify(expected));
      continue;
    }

    // Stored and compared in percentage points so the tolerance reads the
    // same way as the numbers people quote to each other.
    const deltaPoints = actual.wer * 100 - expected.wer * 100;

    if (deltaPoints > tolerancePoints) {
      regressions.push({
        ...identify(expected),
        baselineWer: expected.wer,
        actualWer: actual.wer,
        deltaPoints,
      });
    } else if (deltaPoints < -tolerancePoints) {
      improvements.push({
        ...identify(expected),
        baselineWer: expected.wer,
        actualWer: actual.wer,
        deltaPoints,
      });
    }
  }

  for (const [key, actual] of resultMap) {
    if (!baselineMap.has(key)) {
      unbaselined.push({ ...identify(actual), wer: actual.wer });
    }
  }

  return {
    ok: regressions.length === 0 && missing.length === 0,
    regressions,
    improvements,
    missing,
    unbaselined,
  };
}

/** Renders a comparison as the lines the CI log should show. */
function formatComparison(comparison, { tolerancePoints = 1.5 } = {}) {
  const lines = [];
  const pct = (wer) => `${(wer * 100).toFixed(1)}%`;
  const name = (entry) => entryKey(entry.language, entry.model, entry.mode);

  for (const entry of comparison.regressions) {
    lines.push(
      `REGRESSION ${name(entry)}: ${pct(entry.baselineWer)} -> ` +
        `${pct(entry.actualWer)} (+${entry.deltaPoints.toFixed(1)} points, tolerance ${tolerancePoints})`
    );
  }
  for (const entry of comparison.missing) {
    lines.push(`MISSING ${name(entry)}: baselined but not measured in this run`);
  }
  for (const entry of comparison.improvements) {
    lines.push(
      `IMPROVED ${name(entry)}: ${pct(entry.baselineWer)} -> ` +
        `${pct(entry.actualWer)} (${entry.deltaPoints.toFixed(1)} points). Refresh the baseline to lock it in.`
    );
  }
  for (const entry of comparison.unbaselined) {
    lines.push(`UNBASELINED ${name(entry)}: ${pct(entry.wer)}, not guarded until baselined`);
  }

  if (lines.length === 0) lines.push("All measured pairs are within tolerance of the baseline.");
  return lines;
}

module.exports = { compareToBaseline, formatComparison, entryKey, DEFAULT_MODE };
