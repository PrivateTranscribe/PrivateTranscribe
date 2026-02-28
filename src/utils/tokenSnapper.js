/**
 * Simple edit distance (Levenshtein) for short strings.
 */
const editDistance = (a, b) => {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  const dp = Array.from({ length: la + 1 }, (_, i) => {
    const row = new Array(lb + 1);
    row[0] = i;
    return row;
  });
  for (let j = 1; j <= lb; j++) dp[0][j] = j;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[la][lb];
};

/**
 * Consonant skeleton — strips vowels for phonetic-ish comparison.
 * "provoker" → "prvkr", "privoca" → "prvk"
 */
const consonantSkeleton = (s) => s.toLowerCase().replace(/[aeiou]/g, "");

const DEFAULT_MAX_CANDIDATES = 400;

const looksLikeIdentifier = (word) => {
  if (!word || typeof word !== "string") return false;
  const w = word.trim();
  if (w.length < 2 || w.length > 80) return false;
  // file.ext, camelCase, snake_case, kebab-case, contains digits
  return (
    /\.[a-z0-9]{1,6}$/i.test(w) ||
    /[A-Z]/.test(w) ||
    /[_-]/.test(w) ||
    /\d/.test(w)
  );
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
  return acronym
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
};

const normalizeSpoken = (text) => {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Snap phrases in a transcript to known identifiers (dictionary + correction memory).
 *
 * Privacy model: runs fully local.
 */
export function snapTranscript({ transcript, dictionaryWords = [], corrections = [], maxCandidates = DEFAULT_MAX_CANDIDATES }) {
  const original = typeof transcript === "string" ? transcript : "";
  if (!original.trim()) return original;

  // Apply explicit correction pairs first (only high-confidence: count >= 2).
  let output = original;
  for (const row of corrections || []) {
    const source = row?.source;
    const target = row?.target;
    const count = row?.count || 0;
    if (!source || !target || source === target) continue;
    // Skip low-confidence corrections (seen only once) to avoid false positives
    if (count < 2) continue;
    const re = new RegExp(`\\b${escapeRegExp(source)}\\b`, "gi");
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

  // ── Fuzzy dictionary matching ──────────────────────────────────────────────
  // For ALL dictionary words (not just identifier-like ones), check each word in
  // the output for close phonetic/spelling similarity. This catches cases like
  // "provoker" → "Privoca" where Whisper picks a real word that sounds similar.
  const allDictWords = (dictionaryWords || []).filter((w) => w && w.length >= 3);
  if (allDictWords.length > 0) {
    const outputWords = output.split(/(\s+)/); // preserve whitespace tokens
    for (let i = 0; i < outputWords.length; i++) {
      const token = outputWords[i];
      if (!token || /^\s+$/.test(token)) continue;
      // strip trailing punctuation for matching, preserve it for replacement
      const punctMatch = token.match(/^([a-zA-Z\u00C0-\u024F]+)([^a-zA-Z]*)$/);
      if (!punctMatch) continue;
      const rawWord = punctMatch[1];
      const trailing = punctMatch[2];
      const normWord = rawWord.toLowerCase();
      if (normWord.length < 3) continue;

      for (const dictWord of allDictWords) {
        const normDict = dictWord.toLowerCase();
        // Skip exact matches (already correct)
        if (normWord === normDict) break;

        // Fuzzy match: edit distance relative to word length
        // Conservative thresholds to avoid false positives (e.g. "product" ≠ "Privoca")
        const dist = editDistance(normWord, normDict);
        const longer = Math.max(normWord.length, normDict.length);
        // Allow 1 edit for short words (≤5), 2 for medium (6-8), max 2 for longer
        const maxDist = longer <= 5 ? 1 : 2;
        // Words must also be very similar length (within 2 chars)
        if (Math.abs(normWord.length - normDict.length) > 2) continue;
        const isMatch = dist > 0 && dist <= maxDist;

        if (isMatch) {
          // Preserve original capitalization pattern
          const replacement = rawWord[0] === rawWord[0].toUpperCase()
            ? dictWord[0].toUpperCase() + dictWord.slice(1)
            : dictWord;
          outputWords[i] = replacement + trailing;
          break; // first match wins
        }
      }
    }
    output = outputWords.join("");
  }

  return output;
}

export function inferCorrectionPairs(insertedText, correctedText) {
  const a = normalizeSpoken(insertedText);
  const b = normalizeSpoken(correctedText);
  if (!a || !b || a === b) return [];

  // Heuristic v1: if both are single "identifier-like" tokens, learn that mapping.
  const aTokens = a.split(" ").filter(Boolean);
  const bTokens = b.split(" ").filter(Boolean);

  if (aTokens.length === 1 && bTokens.length === 1) {
    return [{ source: aTokens[0], target: bTokens[0] }];
  }

  // Heuristic v1.5: if the user corrected a multi-word phrase into a single identifier,
  // learn the *phrase → identifier* mapping (e.g. "is login error" → "isLoginError").
  //
  // Notes:
  // - We persist the normalized phrase (lowercase, spaces) as the source.
  // - We keep the original corrected identifier (case-sensitive) as the target.
  const correctedRaw = typeof correctedText === "string" ? correctedText.trim() : "";
  if (
    aTokens.length >= 2 &&
    aTokens.length <= 8 &&
    bTokens.length === 1 &&
    correctedRaw &&
    !/\s/.test(correctedRaw) &&
    looksLikeIdentifier(correctedRaw)
  ) {
    return [{ source: a, target: correctedRaw }];
  }

  // Heuristic v2: if same token count, learn token-level replacements.
  if (aTokens.length === bTokens.length && aTokens.length <= 30) {
    const pairs = [];
    for (let i = 0; i < aTokens.length; i++) {
      if (aTokens[i] !== bTokens[i]) {
        pairs.push({ source: aTokens[i], target: bTokens[i] });
      }
    }
    // Cap to avoid learning nonsense.
    return pairs.slice(0, 8);
  }

  return [];
}
