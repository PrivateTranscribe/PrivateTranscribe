import { useState, useEffect, useRef } from "react";

/**
 * useMicLevel - real-time microphone amplitude tracking for voice-reactive UI.
 *
 * Taps into the existing MediaStream held by AudioManager to avoid opening a
 * second getUserMedia request. Returns a smoothed 0–1 level value that is
 * intentionally laggy-smooth (elegant, not jittery).
 *
 * Uses a module-level singleton AudioContext that survives across recordings.
 * This prevents the "bars freeze after display sleep/wake" bug on Windows where
 * a freshly-created AudioContext.resume() resolves but ctx.state never returns
 * to "running", causing getFloatTimeDomainData to return all zeros.
 *
 * The AnalyserNode and MediaStreamSourceNode are still created/destroyed per
 * recording because they are bound to the stream. Only the AudioContext is shared.
 *
 * @param {React.RefObject} audioManagerRef - ref holding the AudioManager instance
 * @param {boolean} isRecording - current recording state
 * @returns {number} micLevel - smoothed amplitude in [0, 1]
 */

// ---------------------------------------------------------------------------
// Module-level singleton — one AudioContext for the lifetime of the renderer
// ---------------------------------------------------------------------------
let sharedCtx = null;

/**
 * Returns the shared AudioContext, creating it on first call.
 * If the existing context was closed (should not happen in normal use),
 * a new one is created.
 */
function getSharedAudioContext() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;

  if (!sharedCtx || sharedCtx.state === "closed") {
    sharedCtx = new AudioCtx();

    // Proactively resume whenever the page becomes visible again (e.g. after
    // the display wakes from sleep). This covers the case where the context
    // was suspended by the OS while the screen was off.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && sharedCtx?.state === "suspended") {
        sharedCtx.resume().catch(() => {});
      }
    });

    // Also resume when the Electron window is shown after being hidden
    // (visibilitychange does not always fire for Electron window show/hide)
    window.electronAPI?.onMainWindowShown?.(() => {
      if (sharedCtx?.state === "suspended") {
        sharedCtx.resume().catch(() => {});
      }
    });
  }

  return sharedCtx;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export function useMicLevel(audioManagerRef, isRecording) {
  const [micLevel, setMicLevel] = useState(0);
  const smoothedRef = useRef(0);
  const rafRef = useRef(null);
  const cleanupRef = useRef(null);

  useEffect(() => {
    if (!isRecording) {
      cancelAnimationFrame(rafRef.current);
      cleanupRef.current?.();
      cleanupRef.current = null;
      smoothedRef.current = 0;
      setMicLevel(0);
      return;
    }

    let cancelled = false;

    const setupAnalyser = (stream) => {
      if (cancelled) return;

      try {
        const ctx = getSharedAudioContext();
        if (!ctx) return;

        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();

        // 256 FFT size gives ~6ms resolution - enough for voice, not too fine
        analyser.fftSize = 256;
        // No smoothing from analyser; we do manual exponential smoothing below
        analyser.smoothingTimeConstant = 0;

        source.connect(analyser);

        const dataArray = new Float32Array(analyser.fftSize);

        const ATTACK = 0.35; // fast rise so peaks feel responsive
        const DECAY = 0.1; // slow fall so it feels elegant not jittery
        // Speech RMS typically 0.01–0.25; 0.25 normalizes loud speech to ~1.0
        const SCALE = 0.25;

        const tick = () => {
          if (cancelled) return;

          analyser.getFloatTimeDomainData(dataArray);

          // Root mean square amplitude
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i] * dataArray[i];
          }
          const rms = Math.sqrt(sum / dataArray.length);
          const normalized = Math.min(1, rms / SCALE);

          // Asymmetric exponential smoothing: attack fast, decay slow
          const alpha = normalized > smoothedRef.current ? ATTACK : DECAY;
          smoothedRef.current = smoothedRef.current * (1 - alpha) + normalized * alpha;

          setMicLevel(smoothedRef.current);
          rafRef.current = requestAnimationFrame(tick);
        };

        // Register per-recording cleanup. Note: we do NOT close sharedCtx here
        // because it is reused across recordings. Only the source node is torn down.
        cleanupRef.current = () => {
          try {
            source.disconnect();
          } catch {
            // Ignore teardown errors
          }
        };

        // If the context wakes mid-recording (e.g. display sleep ends while
        // recording is already in progress), restart the tick loop.
        const handleStateChange = () => {
          if (ctx.state === "running" && !cancelled && rafRef.current === null) {
            rafRef.current = requestAnimationFrame(tick);
          }
        };
        ctx.addEventListener("statechange", handleStateChange);

        // When the display sleeps, requestAnimationFrame stops firing and the
        // last scheduled frame ID becomes stale. On wake, forcibly cancel the
        // old RAF and kick a fresh tick so the bars resume immediately.
        const handleVisibility = () => {
          if (document.visibilityState === "visible" && !cancelled) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
            if (ctx.state === "suspended") {
              ctx.resume().catch(() => {});
            }
            rafRef.current = requestAnimationFrame(tick);
          }
        };
        document.addEventListener("visibilitychange", handleVisibility);

        // Resume when the Electron window is shown after being hidden
        const handleWindowShown = () => {
          if (!cancelled) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
            if (ctx.state === "suspended") {
              ctx.resume().catch(() => {});
            }
            rafRef.current = requestAnimationFrame(tick);
          }
        };
        const unsubWindowShown = window.electronAPI?.onMainWindowShown?.(handleWindowShown);

        // Resume when window loses focus to a game — Chromium may suspend AudioContext on blur
        const handleWindowBlur = () => {
          if (!cancelled && ctx.state === "suspended") {
            ctx.resume().catch(() => {});
          }
        };
        const unsubWindowBlur = window.electronAPI?.onMainWindowBlur?.(handleWindowBlur);

        // Poll every 500ms while recording to catch any suspension missed by events
        const resumeInterval = setInterval(() => {
          if (!cancelled && ctx.state === "suspended") {
            ctx.resume().then(() => {
              if (!cancelled && rafRef.current === null) {
                rafRef.current = requestAnimationFrame(tick);
              }
            }).catch(() => {});
          }
        }, 500);

        // Extend cleanup to also remove the statechange and visibility listeners.
        const prevCleanup = cleanupRef.current;
        cleanupRef.current = () => {
          prevCleanup?.();
          ctx.removeEventListener("statechange", handleStateChange);
          document.removeEventListener("visibilitychange", handleVisibility);
          unsubWindowShown?.();
          unsubWindowBlur?.();
          clearInterval(resumeInterval);
        };

        // Chromium/Electron creates AudioContext in "suspended" state when the
        // constructor is not called synchronously from a renderer user-gesture.
        // Recording is triggered via IPC → React state update, so the renderer
        // never sees a synchronous gesture event. Always call resume() first,
        // then poll until ctx.state === "running" before starting the tick loop.
        // This also re-wakes a context that was suspended by a display sleep event.
        const startLoop = () => {
          if (!cancelled) rafRef.current = requestAnimationFrame(tick);
        };

        if (ctx.state === "running") {
          startLoop();
        } else {
          ctx
            .resume()
            .then(() => {
              // Double-check: if still not running after resume(), keep retrying.
              // Electron IPC-triggered recording can leave AudioContext stuck in
              // "suspended" even after resume() resolves on some Windows builds.
              const pollRunning = (attempts = 0) => {
                if (cancelled) return;
                if (ctx.state === "running") {
                  startLoop();
                } else if (attempts < 10) {
                  setTimeout(() => pollRunning(attempts + 1), 50);
                } else {
                  // Give up gracefully — visualization stays flat, recording unaffected.
                  startLoop();
                }
              };
              pollRunning();
            })
            .catch(startLoop);
        }
      } catch {
        // Web Audio API unavailable or stream already closed - fail silently.
        // Visualization degrades to static state, recording is unaffected.
      }
    };

    // Small delay to ensure AudioManager has set recordingStream before we read it.
    const startTimer = setTimeout(() => {
      if (cancelled) return;

      const stream = audioManagerRef.current?.recordingStream;
      if (!stream || !stream.active) {
        // Stream not ready yet - retry once after a further 100ms.  This handles the
        // rare race where getUserMedia resolves and sets isRecording=true before
        // recordingStream is stored in audioManagerRef (e.g. on slow getUserMedia paths).
        const retryTimer = setTimeout(() => {
          if (cancelled) return;
          const retryStream = audioManagerRef.current?.recordingStream;
          if (!retryStream || !retryStream.active) return;
          setupAnalyser(retryStream);
        }, 100);
        // Ensure the retry timer is cancelled if the effect cleans up first.
        cleanupRef.current = () => clearTimeout(retryTimer);
        return;
      }

      setupAnalyser(stream);
    }, 60);

    return () => {
      cancelled = true;
      clearTimeout(startTimer);
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      cleanupRef.current?.();
      cleanupRef.current = null;
      smoothedRef.current = 0;
      setMicLevel(0);
    };
  }, [isRecording, audioManagerRef]);

  return micLevel;
}
