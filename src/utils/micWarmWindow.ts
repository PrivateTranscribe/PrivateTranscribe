// How long the microphone stream is kept "warm" (device open) after a dictation so the
// next hotkey press reuses it instead of paying the getUserMedia cold-start cost. Past this
// window the stream is released and the OS mic-in-use indicator turns off.

export const DEFAULT_MIC_WARM_WINDOW_SECONDS = 120; // 2 minutes
export const DEFAULT_MIC_WARM_WINDOW_MS = DEFAULT_MIC_WARM_WINDOW_SECONDS * 1000;

/**
 * Resolve the configured "keep microphone ready" window (in seconds) into milliseconds.
 * - empty / invalid / negative → default (2 min)
 * - 0 → 0, meaning keep the mic warm indefinitely (never auto-release)
 * - N seconds → N * 1000 ms
 */
export function resolveMicWarmWindowMs(
  rawSeconds: string | number | null | undefined,
  fallbackMs: number = DEFAULT_MIC_WARM_WINDOW_MS
): number {
  if (rawSeconds === null || rawSeconds === undefined || rawSeconds === "") return fallbackMs;
  const seconds = Number(rawSeconds);
  if (!Number.isFinite(seconds) || seconds < 0) return fallbackMs;
  return Math.round(seconds * 1000);
}
