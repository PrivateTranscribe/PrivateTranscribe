const DEFAULT_MAX_CANDIDATES = 400;
const MAX_LEARNED_CORRECTION_PAIRS = 8;
const MAX_LEARNING_TOKEN_COUNT = 160;
const MAX_LEARNED_SPAN_TOKENS = 80;
const MAX_LEARNED_TARGET_LENGTH = 500;

const looksLikeIdentifier = (word) => {
  if (!word || typeof word !== "string") return false;
  const w = word.trim();
  if (w.length < 2 || w.length > 80) return false;
  // file.ext, camelCase, snake_case, kebab-case, contains digits
  return /\.[a-z0-9]{1,6}$/i.test(w) || /[A-Z]/.test(w) || /[_-]/.test(w) || /\d/.test(w);
};

const splitIdentifierToSpoken = (word) => {
  const w = word.trim();
  // file.ts -> file ts
  const noDots = w.replace(/\./g, " ");
  const snake = noDots.replace(/[_-]/g, " ");
  // camelCase -> camel Case
  const camel = snake.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  // ACRONYMWord -> ACRONYM Word
  const acronym = camel.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return acronym.replace(/\s+/g, " ").trim().toLowerCase();
};

/**
 * The key a correction is stored and matched under.
 *
 * Keeps every letter and digit, not just the ASCII ones. Stripping to [a-z0-9]
 * turned "tilstedeværelsen" into "tilstedev relsen" and "gåtur" into "g tur",
 * and a key holding a space where a letter belongs can never match the word it
 * came from - so every Danish correction containing æ, ø or å was learned and
 * then silently never applied. Punctuation still collapses to a space, which is
 * what lets "u de" and "u.de" share one key.
 */
const normalizeSpoken = (text) => {
  return (text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const extractLearningTokens = (text) => {
  const tokens = [];
  const source = String(text || "");
  const re = /[\p{L}\p{N}][\p{L}\p{N}._-]*/gu;
  let match;
  while ((match = re.exec(source)) !== null) {
    const raw = match[0];
    tokens.push({
      raw,
      normalized: normalizeSpoken(raw),
      index: match.index,
      end: match.index + raw.length,
    });
  }
  return tokens;
};

const spanTextForTokens = (text, tokens) => {
  if (tokens.length === 0) return "";
  const value = String(text || "");
  let end = tokens[tokens.length - 1].end;
  while (end < value.length && /[^\p{L}\p{N}\s]/u.test(value[end])) {
    end++;
  }
  return value.slice(tokens[0].index, end).trim();
};

const buildCorrectionRegex = (source, target) => {
  const tokens = extractLearningTokens(source)
    .map((token) => token.normalized)
    .filter(Boolean);

  if (tokens.length === 0) return null;

  const pattern = tokens.map(escapeRegExp).join("[^\\p{L}\\p{N}]+");
  const targetText = String(target || "").trim();
  const trailingSentencePunctuation =
    tokens.length > 1 && targetText.length > 0 && /[.!?]$/.test(targetText);
  const suffix = trailingSentencePunctuation ? "[.!?]*" : "";
  return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}${suffix}(?![\\p{L}\\p{N}])`, "giu");
};

const pushCorrectionPair = (pairs, sourceTokens, targetTokens, correctedText) => {
  if (sourceTokens.length === 0 || targetTokens.length === 0) return;
  if (
    sourceTokens.length > MAX_LEARNED_SPAN_TOKENS ||
    targetTokens.length > MAX_LEARNED_SPAN_TOKENS
  ) {
    return;
  }

  const source = sourceTokens
    .map((token) => token.normalized)
    .filter(Boolean)
    .join(" ");
  const target = spanTextForTokens(correctedText, targetTokens);
  if (!source || !target || target.length > MAX_LEARNED_TARGET_LENGTH) return;
  if (source === normalizeSpoken(target) && targetTokens.every((token) => token.raw === source)) {
    return;
  }

  pairs.push({ source, target });
};

const getCommonTokenAnchors = (sourceTokens, targetTokens) => {
  const a = sourceTokens.map((token) => token.normalized);
  const b = targetTokens.map((token) => token.normalized);
  const rows = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      rows[i][j] =
        a[i] === b[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
  }

  const anchors = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      anchors.push([i, j]);
      i++;
      j++;
    } else if (rows[i + 1][j] >= rows[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  return anchors;
};

const inferSpanCorrectionPairs = (insertedText, correctedText) => {
  const sourceTokens = extractLearningTokens(insertedText);
  const targetTokens = extractLearningTokens(correctedText);
  if (sourceTokens.length === 0 || targetTokens.length === 0) return [];
  if (
    sourceTokens.length > MAX_LEARNING_TOKEN_COUNT ||
    targetTokens.length > MAX_LEARNING_TOKEN_COUNT
  ) {
    return [];
  }

  const anchors = getCommonTokenAnchors(sourceTokens, targetTokens);
  const pairs = [];
  let sourceStart = 0;
  let targetStart = 0;

  for (const [sourceAnchor, targetAnchor] of anchors) {
    pushCorrectionPair(
      pairs,
      sourceTokens.slice(sourceStart, sourceAnchor),
      targetTokens.slice(targetStart, targetAnchor),
      correctedText
    );
    sourceStart = sourceAnchor + 1;
    targetStart = targetAnchor + 1;
  }

  pushCorrectionPair(
    pairs,
    sourceTokens.slice(sourceStart),
    targetTokens.slice(targetStart),
    correctedText
  );
  return pairs.slice(0, MAX_LEARNED_CORRECTION_PAIRS);
};

/**
 * Snap phrases in a transcript to known identifiers (dictionary + correction memory).
 *
 * Privacy model: runs fully local.
 */
export function snapTranscript({
  transcript,
  dictionaryWords = [],
  corrections = [],
  maxCandidates = DEFAULT_MAX_CANDIDATES,
}) {
  const original = typeof transcript === "string" ? transcript : "";
  if (!original.trim()) return original;

  // Apply explicit correction pairs first.
  // Only corrections explicitly approved by the user may alter future text.
  // Counts are retained for migration/display purposes but never substitute for consent.
  let output = original;
  const sortedCorrections = [...(corrections || [])].sort((a, b) => {
    const aLength = extractLearningTokens(a?.source).length;
    const bLength = extractLearningTokens(b?.source).length;
    return bLength - aLength;
  });

  for (const row of sortedCorrections) {
    const source = row?.source;
    const target = row?.target;
    const confirmed = row?.confirmed ? true : false;
    if (!source || !target || source === target) continue;
    if (!confirmed) continue;
    const re = buildCorrectionRegex(source, target);
    if (!re) continue;
    output = output.replace(re, target);
  }

  const candidates = (dictionaryWords || [])
    .filter(looksLikeIdentifier)
    .slice(0, maxCandidates)
    .map((word) => ({
      word,
      spoken: splitIdentifierToSpoken(word),
    }))
    .filter((c) => c.spoken && c.spoken.length >= 2);

  if (candidates.length === 0) return output;

  // For each candidate, replace its spoken form when it appears as a phrase.
  // Example: "is login error" -> isLoginError
  const normalizedOutput = normalizeSpoken(output);

  // quick exit if transcript doesn't contain any spaces (single token)
  // still allow snapping if candidate spoken matches the whole transcript.
  for (const c of candidates) {
    if (!c.spoken) continue;

    // Only attempt if the spoken variant appears in a normalized sense.
    if (!normalizedOutput.includes(c.spoken)) continue;

    // Replace phrase in original text (case-insensitive, word-boundary-ish)
    // We allow flexible whitespace.
    const parts = c.spoken.split(" ").map(escapeRegExp);
    const phraseRe = new RegExp(`\\b${parts.join("\\s+")}\\b`, "gi");
    output = output.replace(phraseRe, c.word);
  }

  // Dictionary words are handled via Whisper's initial_prompt hints (pre-transcription).
  // Post-transcription fuzzy replacement was removed - it caused false positives
  // (e.g. "product" → "PrivateTranscribe"). Use Correction Memory for explicit replacements.

  return output;
}

/**
 * Machine-readable reasons the auto-learn guards can refuse a detected correction.
 *
 * These are the only values `explainCorrectionRejection` can return besides `null`.
 */
export const CORRECTION_REJECTION_REASONS = Object.freeze({
  /** Nothing comparable changed (empty text, or the edit is a no-op after normalization). */
  NO_CHANGE: "no-change",
  /** The corrected text dropped 60%+ of the words, so it reads as a cleared field, not a fix. */
  MOSTLY_DELETED: "mostly-deleted",
  /** Under 50% token overlap, so the corrected text is not derived from the dictation. */
  TOO_DIFFERENT: "too-different",
  /** A real near-miss: the edit adds or removes words, and word mode learns 1:1 only. */
  TOKEN_COUNT_CHANGED: "token-count-changed",
  /** Same word count, but too many words to learn safely (>30). */
  TOO_LONG: "too-long",
  /** Phrase learning is on and the span diff produced nothing learnable. */
  NO_LEARNABLE_SPAN: "no-learnable-span",
});

const rejected = (reason) => ({ pairs: [], reason });
const learned = (pairs) => ({ pairs, reason: null });

/**
 * Single source of truth for the auto-learn guards.
 *
 * Returns `{ pairs, reason }` where `reason` is null exactly when `pairs` is non-empty,
 * so `inferCorrectionPairs` and `explainCorrectionRejection` can never disagree.
 */
const analyzeCorrection = (insertedText, correctedText, options = {}) => {
  // Raw/trim checks first: normalizeSpoken would turn empty into "" anyway, but we
  // want to explicitly treat "cleared" clipboard/text as a non-learning event.
  const correctedRaw = typeof correctedText === "string" ? correctedText.trim() : "";
  if (!correctedRaw) return rejected(CORRECTION_REJECTION_REASONS.NO_CHANGE);

  const a = normalizeSpoken(insertedText);
  const b = normalizeSpoken(correctedText);
  if (!a || !b) return rejected(CORRECTION_REJECTION_REASONS.NO_CHANGE);

  // Phrase/sentence learning is explicitly opt-in and still requires user confirmation before save.
  const aTok0 = a.split(" ").filter(Boolean);
  const bTok0 = b.split(" ").filter(Boolean);

  if (options?.allowPhraseLearning === true) {
    const spanPairs = inferSpanCorrectionPairs(insertedText, correctedText);
    if (spanPairs.length > 0) return learned(spanPairs);
    return rejected(
      a === b
        ? CORRECTION_REJECTION_REASONS.NO_CHANGE
        : CORRECTION_REJECTION_REASONS.NO_LEARNABLE_SPAN
    );
  }

  // Word-only guardrail: only learn when the correction is clearly derived from the inserted text.
  // Mass-deletion usually means the user cleared the field, not that they intended a correction.
  // If the "corrected" text removes most of the original, it's probably a user clearing the field,
  // not an intended correction.
  // Exception: very short inserts (<= 3 tokens) can legitimately be corrected into a shorter form.
  if (aTok0.length > 3) {
    const removalRatio = (aTok0.length - bTok0.length) / Math.max(1, aTok0.length);
    if (removalRatio >= 0.6) return rejected(CORRECTION_REJECTION_REASONS.MOSTLY_DELETED);
  }

  const aSet = new Set(aTok0);
  let common = 0;
  for (const t of bTok0) if (aSet.has(t)) common++;
  const denom = Math.max(1, Math.min(aTok0.length, bTok0.length));
  const overlap = common / denom;

  // Require at least 50% token overlap (fairly lenient for small edits, but blocks full reverts).
  if (overlap < 0.5) {
    // One low-overlap case is still unmistakably a correction: the same letters re-spaced,
    // e.g. "use login error" -> "useLoginError". Overlap reads as 0 only because the words
    // got glued together. Report it as a word-count change (which is also what it is) so the
    // UI can explain it, instead of filing it with unrelated clipboard copies.
    const glued = (value) => value.replace(/ /g, "");
    return rejected(
      glued(a) === glued(b)
        ? CORRECTION_REJECTION_REASONS.TOKEN_COUNT_CHANGED
        : CORRECTION_REJECTION_REASONS.TOO_DIFFERENT
    );
  }

  // Auto-learning is word-level: source and corrected text must have the same token count.
  const sourceTokens = extractLearningTokens(insertedText);
  const targetTokens = extractLearningTokens(correctedText);
  if (sourceTokens.length !== targetTokens.length) {
    return rejected(CORRECTION_REJECTION_REASONS.TOKEN_COUNT_CHANGED);
  }
  if (sourceTokens.length > 30) return rejected(CORRECTION_REJECTION_REASONS.TOO_LONG);

  const aTokens = sourceTokens.map((token) => token.normalized);
  const bTokens = targetTokens.map((token) => token.normalized);

  if (aTokens.length === 1 && bTokens.length === 1) {
    return sourceTokens[0].raw !== targetTokens[0].raw || aTokens[0] !== bTokens[0]
      ? learned([{ source: aTokens[0], target: targetTokens[0].raw }])
      : rejected(CORRECTION_REJECTION_REASONS.NO_CHANGE);
  }

  // Heuristic v2: same token count, so learn token-level replacements.
  const pairs = [];
  for (let i = 0; i < aTokens.length; i++) {
    if (aTokens[i] !== bTokens[i]) {
      pairs.push({ source: aTokens[i], target: targetTokens[i].raw });
    } else if (sourceTokens[i].raw !== targetTokens[i].raw) {
      pairs.push({ source: aTokens[i], target: targetTokens[i].raw });
    }
  }
  // Cap to avoid learning nonsense.
  if (pairs.length === 0) return rejected(CORRECTION_REJECTION_REASONS.NO_CHANGE);
  return learned(pairs.slice(0, 8));
};

export function inferCorrectionPairs(insertedText, correctedText, options = {}) {
  return analyzeCorrection(insertedText, correctedText, options).pairs;
}

/**
 * Why the auto-learn guards refused a detected correction.
 *
 * Returns `null` when `inferCorrectionPairs` would produce at least one pair, otherwise
 * one of `CORRECTION_REJECTION_REASONS`. Pure and deterministic; it re-runs the same
 * analysis rather than mutating or relaxing any guard.
 */
export function explainCorrectionRejection(insertedText, correctedText, options = {}) {
  return analyzeCorrection(insertedText, correctedText, options).reason;
}
