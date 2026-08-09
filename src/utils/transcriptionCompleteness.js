export function assessTranscriptionCompleteness({ text, durationSeconds }) {
  const duration = Number(durationSeconds);
  const words = String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

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
