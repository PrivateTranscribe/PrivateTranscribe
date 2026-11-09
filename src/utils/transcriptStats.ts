/**
 * Timestamped transcript lines start with their time, and speaker-labelled
 * lines with the speaker after it: "[01:02:03] Speaker 2: words". Neither is
 * something anyone said.
 */
const LINE_PREFIX = /^\[\d+:\d{2}:\d{2}\]\s+(?:(?:Speaker \d+|Unknown speaker):\s+)?/;

/**
 * Words and lines of a transcript as the Transcribe page reports them. Words
 * are the spoken ones: each line's timestamp and speaker label are left out.
 */
export function countTranscript(text: string): { words: number; lines: number } {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const words = lines.reduce(
    (total, line) => total + line.replace(LINE_PREFIX, "").split(/\s+/).filter(Boolean).length,
    0
  );
  return { words, lines: lines.length };
}
