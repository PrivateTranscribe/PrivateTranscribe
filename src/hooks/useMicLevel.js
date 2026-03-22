import { useState, useEffect, useRef } from "react";

/**
 * useMicLevel - real-time microphone amplitude tracking for voice-reactive UI.
 *
 * Taps into the existing MediaStream held by AudioManager to avoid opening a
 * second getUserMedia request. Returns a smoothed 0–1 level value that is
 * intentionally laggy-smooth (elegant, not jittery).
 *
 * Cleanup is guaranteed: AnalyserNode is disconnected and AudioContext is
 * closed whenever isRecording goes false or the component unmounts.
 *
 * @param {React.RefObject} audioManagerRef - ref holding the AudioManager instance
 * @param {boolean} isRecording - current recording state
 * @returns {number} micLevel - smoothed amplitude in [0, 1]
 */
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
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;

        const ctx = new AudioCtx();

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

        // Register cleanup before the async resume so that if the effect
        // tears down while ctx.resume() is still pending, source and ctx
        // are properly closed regardless.
        cleanupRef.current = () => {
          try {
            source.disconnect();
            ctx.close();
          } catch {
            // Ignore teardown errors
          }
        };

        // Chromium/Electron creates AudioContext in "suspended" state when the
        // constructor is not called synchronously from a renderer user-gesture.
        // Recording is triggered via IPC → React state update, so the renderer
        // never sees a synchronous gesture event. Fire-and-forgetting resume()
        // (as was done before) starts the tick loop while the context is still
        // suspended, causing getFloatTimeDomainData to return all zeros - a flat
        // line. Instead, wait for the context to be running before ticking.
        // The catch path still starts the loop as a fallback (some environments
        // resolve without a gesture; if ctx stays suspended the bars will remain
        // at zero but audio recording is unaffected).
        const startLoop = () => {
          if (!cancelled) rafRef.current = requestAnimationFrame(tick);
        };
        if (ctx.state === "running") {
          startLoop();
        } else {
          ctx.resume().then(startLoop).catch(startLoop);
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
      cleanupRef.current?.();
      cleanupRef.current = null;
      smoothedRef.current = 0;
      setMicLevel(0);
    };
  }, [isRecording, audioManagerRef]);

  return micLevel;
}
