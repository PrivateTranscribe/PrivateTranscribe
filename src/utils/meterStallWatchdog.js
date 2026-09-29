/**
 * Decides when the overlay's level meter should replace the shared
 * AudioContext because the context has stopped rendering.
 *
 * Exact-zero samples are not that signal. Chromium's fake capture device, a
 * muted microphone and noise-gated virtual microphones all deliver true
 * digital silence while the context renders normally. The meter used to read
 * three seconds of zeros as a dead graph and replace the context, which cut
 * off everything else listening on it: the dictation speech gate kept reading
 * the closed context and dropped a dictation with speech in it as silent.
 *
 * The context's own clock is the proof. A context that is not running, or
 * whose currentTime has stopped advancing, renders nothing, whatever its
 * analysers still hand back.
 */

export const METER_STALL_MS = 3000;
export const METER_MAX_SELF_HEALS = 3;

export function createMeterStallWatchdog(
  startedAt,
  { stallMs = METER_STALL_MS, maxHeals = METER_MAX_SELF_HEALS } = {}
) {
  let lastRenderAt = startedAt;
  let lastClock = null;
  let heals = 0;

  return {
    /** Replacements made since the context last rendered; for logging. */
    get heals() {
      return heals;
    },

    /**
     * Feed one meter tick. Returns true when the context has rendered nothing
     * for `stallMs` and should be replaced. The deadline then restarts, so the
     * replacement gets its own `stallMs` to prove it renders.
     */
    shouldReplaceContext({ running, clock, now }) {
      if (running && lastClock !== null && clock > lastClock) {
        lastRenderAt = now;
        heals = 0;
      }
      lastClock = clock;

      if (heals >= maxHeals || now - lastRenderAt <= stallMs) {
        return false;
      }

      heals += 1;
      lastRenderAt = now;
      lastClock = null;
      return true;
    },
  };
}
