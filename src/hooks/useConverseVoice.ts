import { useCallback, useEffect, useRef, useState } from "react";
import AudioManager from "../helpers/audioManager";
import { classifyNonSpeechArtifact } from "../utils/nonSpeechArtifact";
import { getSharedAudioContext, waitForAudioContextRunning } from "../utils/sharedAudioContext";
import { VAD_POLL_MS, VoiceActivityDetector } from "../utils/converseVad";
import logger from "../utils/logger";

/**
 * The microphone half of Converse: hold the microphone open for the length of a
 * session, decide where each spoken turn begins and ends, transcribe it, and
 * hand the text to the caller — which sends it to the agent exactly as a typed
 * message would be.
 *
 * Three things it deliberately does NOT do:
 *
 *   It never opens the microphone on its own. Only a running session with
 *   hands-free switched on does that, and turning either off releases the
 *   device — the operating system's own microphone indicator is then telling
 *   the truth about this app.
 *
 *   It never answers a permission question. A spoken "yes" that whisper
 *   invented out of room noise must not be able to allow a tool, so those stay
 *   on their buttons.
 *
 *   It never guesses that a turn happened. Transcription runs through the same
 *   AudioManager path dictation uses, including the check that drops whisper's
 *   invented stock phrases, because in a hands-free loop an invented sentence
 *   would reach the agent without anyone reading it first.
 */

/** What the microphone is doing, in the order a turn goes through them. */
export type ConverseVoicePhase =
  | "off"
  | "starting"
  | "listening"
  | "hearing"
  | "transcribing"
  | "muted"
  | "error";

export interface ConverseVoiceOptions {
  /** The user wants to talk instead of type. */
  enabled: boolean;
  /** A session is running. Without one there is nothing to talk to. */
  active: boolean;
  /** Hold the input closed — the agent is speaking and the mic would hear it. */
  muted: boolean;
  /** Silence that ends a turn. */
  endOfTurnMs: number;
  /** A finished, transcribed turn. */
  onUtterance: (text: string) => void;
  /** The moment speech is detected, before any transcription — this is barge-in. */
  onSpeechStart?: () => void;
}

export interface ConverseVoice {
  phase: ConverseVoicePhase;
  /** Smoothed 0..1 microphone level for the meter. */
  level: number;
  /** Fatal: the microphone could not be opened. Cleared by `retry`. */
  error: string | null;
  /** Non-fatal: one turn could not be transcribed. The loop kept listening. */
  notice: string | null;
  retry: () => void;
}

/**
 * A recording is rotated after this much unbroken quiet, so the clip handed to
 * whisper is the sentence and a little room tone rather than however long the
 * user sat thinking. Webm chunks are not independently decodable, so a clip
 * always starts at a recorder start — this is what bounds it.
 */
const IDLE_SEGMENT_MS = 4000;

/** Quiet required before a rotation, so one can never land on a word's first syllable. */
const ROTATE_AFTER_QUIET_MS = 1200;

/** Speech RMS is roughly 0.01-0.25; 0.25 puts loud speech at a full meter. */
const LEVEL_SCALE = 0.25;
const LEVEL_ATTACK = 0.35;
const LEVEL_DECAY = 0.1;

function microphoneErrorMessage(error: unknown): string {
  const name = (error as { name?: string } | null)?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access was refused. Allow PrivateTranscribe to use the microphone, then turn voice back on.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No microphone was found. Choose one in Settings, then turn voice back on.";
  }
  if (name === "NotReadableError") {
    return "The microphone is in use by another app. Close it, then turn voice back on.";
  }
  const message = error instanceof Error ? error.message : String(error);
  return "The microphone could not be opened. " + message;
}

export function useConverseVoice({
  enabled,
  active,
  muted,
  endOfTurnMs,
  onUtterance,
  onSpeechStart,
}: ConverseVoiceOptions): ConverseVoice {
  const [phase, setPhase] = useState<ConverseVoicePhase>("off");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Bumped by `retry`, which is the only way back out of a fatal error. */
  const [attempt, setAttempt] = useState(0);

  const onUtteranceRef = useRef(onUtterance);
  const onSpeechStartRef = useRef(onSpeechStart);
  onUtteranceRef.current = onUtterance;
  onSpeechStartRef.current = onSpeechStart;

  const managerRef = useRef<AudioManager | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const vadRef = useRef<VoiceActivityDetector | null>(null);
  const mutedRef = useRef(muted);
  /** Transcriptions run one after another, so two turns cannot arrive swapped. */
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const shouldRun = enabled && active;

  useEffect(() => {
    vadRef.current?.setEndOfTurnMs(endOfTurnMs);
  }, [endOfTurnMs]);

  // The input is closed by disabling the track rather than by dropping the
  // stream: re-acquiring a device between every turn costs a few hundred
  // milliseconds, which is exactly where the user's first word would land.
  useEffect(() => {
    mutedRef.current = muted;
    const track = streamRef.current?.getAudioTracks()[0];
    if (track) track.enabled = !muted;
    if (!streamRef.current) return;
    vadRef.current?.reset();
    setLevel(0);
    setPhase(muted ? "muted" : "listening");
  }, [muted]);

  useEffect(() => {
    if (!shouldRun) {
      setPhase("off");
      setLevel(0);
      return undefined;
    }

    let cancelled = false;
    let stream: MediaStream | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let samples: Float32Array | null = null;
    let timer: number | null = null;
    let smoothed = 0;

    /** The recorder currently capturing, and what it has produced so far. */
    let segment: { recorder: MediaRecorder; chunks: Blob[]; startedAt: number } | null = null;
    let lastLoudAt = 0;

    const manager = managerRef.current || new AudioManager();
    managerRef.current = manager;

    const startSegment = (): void => {
      const live = stream;
      if (!live) return;
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(live);
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };
      recorder.start();
      segment = { recorder, chunks, startedAt: performance.now() };
    };

    const transcribe = async (blob: Blob, durationSeconds: number): Promise<void> => {
      if (!cancelled) setPhase("transcribing");
      try {
        const { result } = await manager.runTranscription(blob, {
          source: "converse",
          durationSeconds,
        });
        if (cancelled) return;

        const raw = typeof result?.text === "string" ? result.text.trim() : "";
        if (!raw) {
          setPhase(mutedRef.current ? "muted" : "listening");
          return;
        }

        // The same guard dictation uses. Whisper cannot answer "that was a
        // door closing", it answers "Thank you." — and here nobody would read
        // it before the agent did.
        const artifact = classifyNonSpeechArtifact(raw, { durationSeconds });
        if (artifact.isArtifact) {
          logger.info(
            "Converse dropped a non-speech transcript",
            { reason: artifact.reason, text: raw },
            "transcription"
          );
          setPhase(mutedRef.current ? "muted" : "listening");
          return;
        }

        const text =
          typeof manager.applyDictionaryReplacements === "function"
            ? manager.applyDictionaryReplacements(raw)
            : raw;

        setNotice(null);
        setPhase(mutedRef.current ? "muted" : "listening");
        onUtteranceRef.current?.(text);
      } catch (err) {
        if (cancelled) return;
        logger.warn(
          "Converse could not transcribe a turn",
          { error: err instanceof Error ? err.message : String(err) },
          "transcription"
        );
        setNotice("That turn could not be transcribed. Say it again, or type it below.");
        setPhase(mutedRef.current ? "muted" : "listening");
      }
    };

    /**
     * End the current recording and start the next one in the same breath. Two
     * MediaRecorders may share a stream, so the new one is already capturing
     * before the old one has finished flushing — nothing is lost between turns.
     */
    const rotateSegment = (keep: boolean): void => {
      const ending = segment;
      segment = null;
      if (!ending) {
        startSegment();
        return;
      }

      const endedAt = performance.now();
      const settled = new Promise<Blob | null>((resolve) => {
        ending.recorder.onstop = () => {
          if (!keep || ending.chunks.length === 0) {
            resolve(null);
            return;
          }
          resolve(new Blob(ending.chunks, { type: ending.recorder.mimeType || "audio/webm" }));
        };
      });

      try {
        ending.recorder.stop();
      } catch {
        // Already inactive; the promise settles from whichever stop got there first.
      }
      startSegment();

      if (!keep) return;
      const durationSeconds = (endedAt - ending.startedAt) / 1000;
      queueRef.current = queueRef.current
        .then(async () => {
          const blob = await settled;
          if (cancelled || !blob) return;
          await transcribe(blob, durationSeconds);
        })
        .catch(() => {
          // Never let one failed turn break the queue for every later one.
        });
    };

    const tick = () => {
      if (cancelled || !analyser || !samples) return;
      const now = performance.now();

      // A suspended context hands back zeros forever, and zeros read as a
      // pause. Unreadable is reported as unreadable, and the detector ignores
      // it rather than ending a turn nobody finished.
      let rms: number | null = null;
      const context = analyser.context;
      if (context.state === "running") {
        try {
          analyser.getFloatTimeDomainData(samples);
          let sum = 0;
          for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
          const value = Math.sqrt(sum / samples.length);
          rms = Number.isFinite(value) ? value : null;
        } catch {
          rms = null;
        }
      } else {
        void (context as AudioContext).resume?.().catch?.(() => {});
      }

      if (mutedRef.current) {
        smoothed = 0;
        setLevel(0);
        return;
      }

      const normalized = Math.min(1, (rms ?? 0) / LEVEL_SCALE);
      const alpha = normalized > smoothed ? LEVEL_ATTACK : LEVEL_DECAY;
      smoothed = smoothed * (1 - alpha) + normalized * alpha;
      setLevel(smoothed);

      const vad = vadRef.current;
      if (!vad) return;
      if (rms !== null && rms >= vad.threshold) lastLoudAt = now;

      const event = vad.push(rms, now);
      if (event === "speech-start") {
        setPhase("hearing");
        onSpeechStartRef.current?.();
        return;
      }
      if (event === "speech-end") {
        rotateSegment(true);
        return;
      }
      if (event === "speech-discarded") {
        rotateSegment(false);
        setPhase("listening");
        return;
      }

      // Nothing is being said and the recording has grown into a long clip of
      // room tone. Throw it away and start a fresh one, so the next sentence is
      // transcribed on its own.
      if (
        !vad.isSpeaking &&
        segment &&
        now - segment.startedAt > IDLE_SEGMENT_MS &&
        now - lastLoudAt > ROTATE_AFTER_QUIET_MS
      ) {
        rotateSegment(false);
      }
    };

    void (async () => {
      setError(null);
      setNotice(null);
      setPhase("starting");
      try {
        const constraints = (await manager.getAudioConstraints()) as MediaStreamConstraints;
        const audio =
          typeof constraints.audio === "object" && constraints.audio !== null
            ? constraints.audio
            : {};
        // Echo cancellation and noise suppression matter more here than in
        // dictation: the reply comes out of this machine's own speakers, and
        // without them the agent ends up talking to itself.
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...audio,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;
        const track = stream.getAudioTracks()[0];
        if (track) track.enabled = !mutedRef.current;

        const context = getSharedAudioContext();
        if (!context) throw new Error("Web Audio is unavailable in this window.");
        await waitForAudioContextRunning(context);
        if (cancelled) return;

        source = context.createMediaStreamSource(stream);
        analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0;
        source.connect(analyser);
        samples = new Float32Array(analyser.fftSize);

        vadRef.current = new VoiceActivityDetector({ endOfTurnMs });
        lastLoudAt = performance.now();
        startSegment();

        // The model loads while the user is still finding their first sentence
        // instead of after it.
        manager._preWarmLocalTranscriptionServer?.();

        setPhase(mutedRef.current ? "muted" : "listening");
        timer = window.setInterval(tick, VAD_POLL_MS);
      } catch (err) {
        if (cancelled) return;
        logger.warn(
          "Converse could not open the microphone",
          { error: err instanceof Error ? err.message : String(err) },
          "audio"
        );
        setError(microphoneErrorMessage(err));
        setPhase("error");
      }
    })();

    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
      try {
        segment?.recorder.stop();
      } catch {
        // Already stopped.
      }
      segment = null;
      try {
        source?.disconnect();
        analyser?.disconnect();
      } catch {
        // The graph is already torn down.
      }
      // The context is shared with the level meters and stays open; the device
      // does not. Releasing the tracks is what turns the system's own
      // microphone indicator back off.
      stream?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      vadRef.current = null;
      setLevel(0);
    };
    // `endOfTurnMs` is applied to the live detector by its own effect, so a
    // change to it must not tear the microphone down mid-conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldRun, attempt]);

  useEffect(
    () => () => {
      managerRef.current?.cleanup?.();
      managerRef.current = null;
    },
    []
  );

  const retry = useCallback(() => {
    setError(null);
    setNotice(null);
    setAttempt((current) => current + 1);
  }, []);

  return { phase, level, error, notice, retry };
}
