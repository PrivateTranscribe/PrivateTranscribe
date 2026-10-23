// Chinese, Japanese and Thai are written without spaces between words, so a
// split on whitespace counts a whole sentence of them as one word. The word
// segmenter knows where their words end.
const wordSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "word" })
    : null;

function countWords(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return 0;
  if (!wordSegmenter) return trimmed.split(/\s+/).filter(Boolean).length;
  let count = 0;
  for (const segment of wordSegmenter.segment(trimmed)) {
    if (segment.isWordLike) count += 1;
  }
  return count;
}

export function assessTranscriptionCompleteness({ text, durationSeconds }) {
  const duration = Number(durationSeconds);
  const words = countWords(text);

  if (!Number.isFinite(duration) || duration < 20) {
    return { suspicious: false, reason: null, wordCount: words };
  }

  if (words <= 1) {
    return { suspicious: true, reason: "very-low-word-count", wordCount: words };
  }

  const wordsPerMinute = words / (duration / 60);
  if (duration >= 60 && wordsPerMinute < 5) {
    return { suspicious: true, reason: "very-low-speech-density", wordCount: words };
  }

  return { suspicious: false, reason: null, wordCount: words };
}
