/**
 * How long a one-minute dictation takes to come back at a given real-time
 * factor.
 *
 * The real-time factor is the honest measurement, but "24.4x" is not the
 * question anyone actually has. The question is how long you sit there after
 * you stop talking. This turns the factor into that number so the benchmark
 * card can state it directly and leave the factor as the headline above it.
 *
 * Returns "" for an unusable factor, so callers can drop the line entirely
 * rather than render a half-finished sentence.
 */
export function formatOneMinuteWait(factor: number): string {
  if (!Number.isFinite(factor) || factor <= 0) return "";

  const seconds = 60 / factor;

  if (seconds < 1) return "under a second";
  // Guard the 1.0 case so it never reads "about 1.0 seconds".
  if (seconds < 1.05) return "about a second";
  if (seconds < 10) return `about ${seconds.toFixed(1)} seconds`;
  if (seconds < 60) return `about ${Math.round(seconds)} seconds`;
  return `about ${(seconds / 60).toFixed(1)} minutes`;
}
