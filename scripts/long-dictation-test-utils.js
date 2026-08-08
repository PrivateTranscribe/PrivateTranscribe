function normalizeTranscript(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .replace(/(^|\s)'|'(?=\s|$)/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function getWords(text) {
  const normalized = normalizeTranscript(text);
  return normalized ? normalized.split(" ") : [];
}

function computeWordErrorRate(reference, hypothesis) {
  const referenceWords = getWords(reference);
  const hypothesisWords = getWords(hypothesis);
  let previous = Array.from({ length: hypothesisWords.length + 1 }, (_, index) => index);

  for (let row = 1; row <= referenceWords.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= hypothesisWords.length; column += 1) {
      const substitutionCost = referenceWords[row - 1] === hypothesisWords[column - 1] ? 0 : 1;
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + substitutionCost
      );
    }
    previous = current;
  }

  const errors = previous[hypothesisWords.length];
  return {
    errors,
    referenceWordCount: referenceWords.length,
    wordErrorRate:
      referenceWords.length === 0 ? (errors === 0 ? 0 : 1) : errors / referenceWords.length,
  };
}

function passageRecall(passage, transcript) {
  const passageWords = getWords(passage);
  if (passageWords.length === 0) return 1;
  const transcriptWords = getWords(transcript);
  if (transcriptWords.length === 0) return 0;

  const windowLength = Math.ceil(passageWords.length * 1.5);
  let bestMatchLength = 0;
  for (let start = 0; start < transcriptWords.length; start += 1) {
    const candidate = transcriptWords.slice(start, start + windowLength);
    let previous = new Array(candidate.length + 1).fill(0);

    for (const passageWord of passageWords) {
      const current = [0];
      for (let column = 1; column <= candidate.length; column += 1) {
        current[column] =
          passageWord === candidate[column - 1]
            ? previous[column - 1] + 1
            : Math.max(previous[column], current[column - 1]);
      }
      previous = current;
    }
    bestMatchLength = Math.max(bestMatchLength, previous[candidate.length]);
    if (bestMatchLength === passageWords.length) break;
  }

  return bestMatchLength / passageWords.length;
}

function detectRepeatedTail(transcript, minimumRepetitions = 4) {
  const words = getWords(transcript);
  let bestMatch = null;

  for (let phraseLength = 1; phraseLength <= Math.min(5, words.length); phraseLength += 1) {
    const phrase = words.slice(-phraseLength);
    let repetitions = 1;
    let cursor = words.length - phraseLength * 2;

    while (cursor >= 0) {
      const candidate = words.slice(cursor, cursor + phraseLength);
      if (!candidate.every((word, index) => word === phrase[index])) break;
      repetitions += 1;
      cursor -= phraseLength;
    }

    if (
      repetitions >= minimumRepetitions &&
      (!bestMatch || repetitions * phraseLength > bestMatch.repetitions * bestMatch.phraseLength)
    ) {
      bestMatch = {
        phrase: phrase.join(" "),
        phraseLength,
        repetitions,
      };
    }
  }

  if (!bestMatch) return null;
  return { phrase: bestMatch.phrase, repetitions: bestMatch.repetitions };
}

function detectRepeatedPassage(transcript, minimumWords = 8, maximumWords = 50) {
  const words = getWords(transcript);
  const longestCandidate = Math.min(maximumWords, Math.floor(words.length / 2));

  for (let wordCount = longestCandidate; wordCount >= minimumWords; wordCount -= 1) {
    for (let start = 0; start + wordCount * 2 <= words.length; start += 1) {
      const first = words.slice(start, start + wordCount);
      const second = words.slice(start + wordCount, start + wordCount * 2);
      if (first.every((word, index) => word === second[index])) {
        return { phrase: first.join(" "), wordCount };
      }
    }
  }

  return null;
}

function detectUnexpectedTail(boundaryChecks, transcript, maximumTrailingWords = 3) {
  const ending = (boundaryChecks || []).find((boundary) => boundary.label === "ending");
  if (!ending?.text) return null;

  const endingWords = getWords(ending.text);
  const transcriptWords = getWords(transcript);
  const longestSuffix = Math.min(12, endingWords.length);

  for (let suffixLength = longestSuffix; suffixLength >= 4; suffixLength -= 1) {
    const suffix = endingWords.slice(-suffixLength);
    for (let start = transcriptWords.length - suffixLength; start >= 0; start -= 1) {
      if (!suffix.every((word, index) => word === transcriptWords[start + index])) continue;
      const trailingWords = transcriptWords.slice(start + suffixLength);
      if (trailingWords.length <= maximumTrailingWords) return null;
      return { text: trailingWords.join(" "), wordCount: trailingWords.length };
    }
  }

  return null;
}

function buildBoundaryChecks(clips) {
  if (!Array.isArray(clips) || clips.length === 0) return [];

  const fiveMinuteTarget = 300;
  const fiveMinuteClips = clips.filter(
    (clip) => clip.endSeconds >= fiveMinuteTarget && clip.startSeconds <= fiveMinuteTarget + 15
  );
  const endingClips = clips.slice(-2);
  const checks = [];

  if (fiveMinuteClips.length > 0) {
    checks.push({
      label: "five-minute",
      targetSeconds: fiveMinuteTarget,
      text: fiveMinuteClips.map((clip) => clip.text).join(" "),
    });
  }

  if (endingClips.length > 0) {
    checks.push({
      label: "ending",
      targetSeconds: endingClips.at(-1).startSeconds,
      text: endingClips.map((clip) => clip.text).join(" "),
    });
  }

  return checks;
}

function scoreLongDictation(manifest, transcript, options = {}) {
  const maximumWordErrorRate = options.maximumWordErrorRate ?? 0.2;
  const minimumBoundaryRecall = options.minimumBoundaryRecall ?? 0.7;
  const wordError = computeWordErrorRate(manifest.referenceText, transcript);
  const boundaryResults = (manifest.boundaryChecks || []).map((boundary) => ({
    label: boundary.label,
    recall: passageRecall(boundary.text, transcript),
  }));
  const missingBoundaries = boundaryResults
    .filter((boundary) => boundary.recall < minimumBoundaryRecall)
    .map((boundary) => boundary.label);
  const repeatedTail = detectRepeatedTail(transcript);
  const repeatedPassage = detectRepeatedPassage(transcript);
  const unexpectedTail = detectUnexpectedTail(manifest.boundaryChecks, transcript);

  return {
    passed:
      wordError.wordErrorRate <= maximumWordErrorRate &&
      missingBoundaries.length === 0 &&
      repeatedTail === null &&
      repeatedPassage === null &&
      unexpectedTail === null,
    wordErrorRate: wordError.wordErrorRate,
    wordErrors: wordError.errors,
    referenceWordCount: wordError.referenceWordCount,
    boundaryResults,
    missingBoundaries,
    repeatedPassage,
    repeatedTail,
    unexpectedTail,
  };
}

module.exports = {
  buildBoundaryChecks,
  computeWordErrorRate,
  detectRepeatedPassage,
  detectRepeatedTail,
  detectUnexpectedTail,
  normalizeTranscript,
  scoreLongDictation,
};
