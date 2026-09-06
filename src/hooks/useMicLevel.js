import { useState, useEffect, useRef } from "react";
import {
  __resetSharedAudioContextForTests,
  getSharedAudioContext,
  resetSharedAudioContext,
  waitForAudioContextRunning,
} from "../utils/sharedAudioContext";

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

export { waitForAudioContextRunning };

export function __resetMicLevelAudioContextForTests() {
  __resetSharedAudioContextForTests();
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
        let ctx = getSharedAudioContext();
        if (!ctx) return;

        let source = null;
        let analyser = null;
        let dataArray = null;

        const disconnectSource = () => {
          if (!source) return;
          try {
            source.disconnect();
          } catch {
            // Ignore teardown errors
          }
          source = null;
        };

        const buildAnalyserGraph = (nextCtx) => {
          disconnectSource();

          ctx = nextCtx;
          source = ctx.createMediaStreamSource(stream);
          analyser = ctx.createAnalyser();

          // 256 FFT size gives ~6ms resolution - enough for voice, not too fine
          analyser.fftSize = 256;
          // No smoothing from analyser; we do manual exponential smoothing below
          analyser.smoothingTimeConstant = 0;

          source.connect(analyser);
          dataArray = new Float32Array(analyser.fftSize);
        };

        buildAnalyserGraph(ctx);

        const ATTACK = 0.35; // fast rise so peaks feel responsive
        const DECAY = 0.1; // slow fall so it feels elegant not jittery
        // Speech RMS typically 0.01–0.25; 0.25 normalizes loud speech to ~1.0
        const SCALE = 0.25;

        // Stall self-heal watchdog. A live mic always has a small noise floor,
        // so a sustained EXACT-zero RMS while the context still claims to be
        // "running" means the audio graph has silently gone stale (a zombie
        // context after display sleep/wake, or a fast re-record). When that
        // happens we rebuild the context + analyser once; this never touches
        // the recording stream, so transcription is unaffected.
        const STALL_EPS = 1e-6;
        const STALL_MS = 3000;
        const MAX_SELF_HEAL = 3;
        let lastSignalAt = performance.now();
        let selfHealCount = 0;

        const tick = () => {
          if (cancelled) return;
          rafRef.current = null;

          if (!analyser || !dataArray) return;

          if (ctx.state === "running") {
            analyser.getFloatTimeDomainData(dataArray);
          } else {
            // A suspended analyser can repeat its last nonzero frame forever.
            // Do not let stale samples reset the recovery watchdog.
            dataArray.fill(0);
          }

          // Root mean square amplitude
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i] * dataArray[i];
          }
          const rms = Math.sqrt(sum / dataArray.length);

          const nowTs = performance.now();
          if (rms > STALL_EPS) {
            lastSignalAt = nowTs;
            selfHealCount = 0;
          } else if (selfHealCount < MAX_SELF_HEAL && nowTs - lastSignalAt > STALL_MS) {
            // Recover both a silent running graph and one suspended mid-recording.
            selfHealStalledGraph();
            return;
          }

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
          disconnectSource();
        };

        // If the context wakes mid-recording (e.g. display sleep ends while
        // recording is already in progress), restart the tick loop.
        let stateChangeCtx = null;
        const handleStateChange = () => {
          if (ctx.state === "running" && !cancelled && rafRef.current === null) {
            rafRef.current = requestAnimationFrame(tick);
          }
        };
        const attachStateChangeListener = (nextCtx) => {
          stateChangeCtx?.removeEventListener("statechange", handleStateChange);
          stateChangeCtx = nextCtx;
          stateChangeCtx.addEventListener("statechange", handleStateChange);
        };
        attachStateChangeListener(ctx);

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

        // Also restart the RAF loop when the Electron window is shown after being
        // hidden — visibilitychange may not fire in that case.
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

        // Extend cleanup to also remove the statechange and visibility listeners.
        const prevCleanup = cleanupRef.current;
        cleanupRef.current = () => {
          prevCleanup?.();
          stateChangeCtx?.removeEventListener("statechange", handleStateChange);
          stateChangeCtx = null;
          document.removeEventListener("visibilitychange", handleVisibility);
          unsubWindowShown?.();
        };

        // Chromium/Electron creates AudioContext in "suspended" state when the
        // constructor is not called synchronously from a renderer user-gesture.
        // Recording is triggered via IPC → React state update, so the renderer
        // never sees a synchronous gesture event. Always call resume() first,
        // then poll until ctx.state === "running" before starting the tick loop.
        // This also re-wakes a context that was suspended by a display sleep event.
        const startLoop = () => {
          if (cancelled) return;
          cancelAnimationFrame(rafRef.current);
          rafRef.current = requestAnimationFrame(tick);
        };

        // Rebuild the shared context + analyser graph when the meter detects a
        // stalled (silent-but-"running") pipe. Only the audio graph is rebuilt;
        // the recording stream is left untouched so transcription is unaffected.
        const selfHealStalledGraph = () => {
          if (cancelled) return;
          selfHealCount += 1;
          console.debug("[mic-meter] self-healing stalled audio graph", { selfHealCount });

          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
          lastSignalAt = performance.now();

          const recoveredCtx = resetSharedAudioContext();
          if (!recoveredCtx) {
            startLoop();
            return;
          }

          try {
            buildAnalyserGraph(recoveredCtx);
            attachStateChangeListener(recoveredCtx);
          } catch {
            startLoop();
            return;
          }

          void (async () => {
            await waitForAudioContextRunning(recoveredCtx);
            startLoop();
          })();
        };

        const startWhenAudioContextRuns = async () => {
          if (await waitForAudioContextRunning(ctx)) {
            startLoop();
            return;
          }

          if (cancelled) return;

          const recoveredCtx = resetSharedAudioContext();
          if (!recoveredCtx) {
            startLoop();
            return;
          }

          try {
            buildAnalyserGraph(recoveredCtx);
            attachStateChangeListener(recoveredCtx);
          } catch {
            startLoop();
            return;
          }

          await waitForAudioContextRunning(recoveredCtx);
          startLoop();
        };

        void startWhenAudioContextRuns();
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
