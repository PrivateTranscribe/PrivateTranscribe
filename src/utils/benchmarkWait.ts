/**
 * How long the benchmark actually waited, formatted for display.
 *
 * The headline used to be the real-time factor, which is the precise way to say
 * it and the wrong way to lead: "24.4x" is a ratio nobody has a feel for. The
 * question after a speed test is how long you sit there, so the wait is the
 * headline now and the factor moved to the detail line beside it.
 *
 * Deliberately reports the clip that was measured rather than scaling up to a
 * minute. Cost grows markedly slower than clip length - whisper.cpp pads audio
 * into 30-second windows and a short clip leaves the GPU idle - so multiplying
 * this out produced a figure roughly four times too pessimistic. The website
 * states the same measured pair.
 */
export function formatBenchmarkWait(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return "";

  const seconds = elapsedMs / 1000;

  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;

  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  // 90s reads better as "1m 30s" than "1.5m", and 120s must not become "2m 0s".
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

/** "10 seconds of audio", or "" when the duration is unusable. */
export function formatBenchmarkClip(audioDurationSec: number): string {
  if (!Number.isFinite(audioDurationSec) || audioDurationSec <= 0) return "";
  const rounded = Math.round(audioDurationSec * 10) / 10;
  const value = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${value} seconds of audio`;
}
