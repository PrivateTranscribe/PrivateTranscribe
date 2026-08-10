/**
 * Shared renderer AudioContext.
 *
 * Every consumer that taps the recording stream must go through this module.
 * Creating a fresh AudioContext per recording triggers a Windows/Electron bug
 * where `resume()` resolves but `state` never returns to "running", leaving
 * `getFloatTimeDomainData` returning all zeros — silence that reads as real.
 * A single long-lived context avoids that; only the AnalyserNode and
 * MediaStreamSourceNode are per-recording, because they are bound to a stream.
 */

let sharedCtx = null;
let removeSharedVisibilityListener = null;
let unsubscribeSharedWindowShown = null;

export function disposeSharedAudioContext({ close = false } = {}) {
  const ctx = sharedCtx;

  if (removeSharedVisibilityListener) {
    removeSharedVisibilityListener();
    removeSharedVisibilityListener = null;
  }

  if (unsubscribeSharedWindowShown) {
    unsubscribeSharedWindowShown();
    unsubscribeSharedWindowShown = null;
  }

  sharedCtx = null;

  if (close && ctx && ctx.state !== "closed") {
    try {
      ctx.close?.();
    } catch {
      // Ignore browser teardown errors; a new context will be created on demand.
    }
  }
}

/**
 * Returns the shared AudioContext, creating it on first call.
 * If the existing context was closed (should not happen in normal use),
 * a new one is created.
 */
export function getSharedAudioContext() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;

  if (!sharedCtx || sharedCtx.state === "closed") {
    sharedCtx = new AudioCtx();

    // Proactively resume whenever the page becomes visible again (e.g. after
    // the display wakes from sleep). This covers the case where the context
    // was suspended by the OS while the screen was off.
    const doc = typeof document === "undefined" ? null : document;
    if (doc) {
      const handleSharedVisibility = () => {
        if (doc.visibilityState === "visible" && sharedCtx?.state === "suspended") {
          sharedCtx.resume().catch(() => {});
        }
      };
      doc.addEventListener("visibilitychange", handleSharedVisibility);
      removeSharedVisibilityListener = () => {
        doc.removeEventListener("visibilitychange", handleSharedVisibility);
      };
    }

    // Also resume when the Electron window is shown after being hidden
    // (visibilitychange does not always fire for Electron window show/hide)
    unsubscribeSharedWindowShown = window.electronAPI?.onMainWindowShown?.(() => {
      if (sharedCtx?.state === "suspended") {
        sharedCtx.resume().catch(() => {});
      }
    });
  }

  return sharedCtx;
}

export function resetSharedAudioContext() {
  disposeSharedAudioContext({ close: true });
  return getSharedAudioContext();
}

export async function waitForAudioContextRunning(ctx, { attempts = 10, delayMs = 50 } = {}) {
  if (!ctx || ctx.state === "closed") {
    return false;
  }

  if (ctx.state === "running") {
    return true;
  }

  try {
    await ctx.resume?.();
  } catch {
    return false;
  }

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (ctx.state === "running") {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return ctx.state === "running";
}

export function __resetSharedAudioContextForTests() {
  disposeSharedAudioContext({ close: true });
}
