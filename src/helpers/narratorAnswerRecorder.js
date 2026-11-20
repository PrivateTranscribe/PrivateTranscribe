/**
 * Records a voice answer in the overlay (renderer side) for the narrator's
 * answer window (src/helpers/narrator/voiceAnswers.js).
 *
 * Main says "start", "stop" or "discard" for one recording id. The recording
 * is this class's own and never touches dictation, so nothing it hears can be
 * pasted or typed anywhere. While it records, a voice call's push-to-mute key
 * is held, as for dictation, so the call does not hear the answer. On "stop"
 * the audio is transcribed locally, without AI cleanup, and only the text
 * goes back to main, which matches it to the question's own options.
 */

import AudioManager from "./audioManager";
import logger from "../utils/logger";
import { readStoredHotkey } from "../utils/hotkeys";
import { nextVoiceLevel } from "../utils/voiceBars";

/** How often the level of an answer being recorded is read for the overlay. */
const LEVEL_EVERY_MS = 50;

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export class NarratorAnswerRecorder {
  /**
   * @param {object} opts
   * @param {() => boolean} opts.isLocalOnly   local transcription with no cloud fallback
   * @param {object} [opts.api]   window.electronAPI
   * @param {() => object} [opts.createManager]   an AudioManager, made on first use
   * @param {{getUserMedia: Function}} [opts.mediaDevices]
   * @param {(level: number) => void} [opts.onLevel]   0-1 while an answer records, so the overlay shows it is heard
   */
  constructor({ isLocalOnly, api, createManager, mediaDevices, onLevel } = {}) {
    this.onLevel = onLevel || null;
    this.isLocalOnly = isLocalOnly || (() => false);
    this.api = api || (typeof window === "undefined" ? null : window.electronAPI);
    this.createManager = createManager || (() => new AudioManager());
    this.mediaDevices =
      mediaDevices || (typeof navigator === "undefined" ? null : navigator.mediaDevices);
    this.manager = null;
    /** The recording running or starting, or null. */
    this.current = null;
  }

  /** One message from main. */
  handle(message) {
    const id = typeof message?.id === "string" ? message.id : "";
    if (!id) return;
    if (message.type === "start") void this._start(id, message.language);
    else if (message.type === "stop") void this._stop(id);
    else if (message.type === "discard") this._discard(id);
  }

  dispose() {
    if (this.current) this._discard(this.current.id);
  }

  /**
   * Starts the local engine while a question is still being asked. A cold
   * engine loads its model only once the answer arrives, which can take
   * seconds, and a press in that wait cancels the question.
   */
  prepare() {
    if (!this.isLocalOnly()) return;
    try {
      this.manager = this.manager || this.createManager();
      this.manager.prewarmTranscription?.();
    } catch {
      // Warming up is an optimization only.
    }
  }

  async _start(id, language) {
    if (this.current) this._discard(this.current.id);
    // Every word the microphone hears here must stay on this PC.
    if (!this.isLocalOnly()) {
      this._report(id, { error: "not-local" });
      return;
    }
    this.prepare();
    const take = {
      id,
      /** The question's language: an answer of a word or two is too short to detect one. */
      language: language === "da" || language === "en" ? language : null,
      chunks: [],
      stream: null,
      recorder: null,
      startedAt: performance.now(),
      /** When the microphone opened, or null while it opens. */
      openedAt: null,
      stopping: false,
      discarded: false,
      muted: false,
      meter: null,
    };
    this.current = take;
    this._muteCall(take);
    try {
      this.manager = this.manager || this.createManager();
      const constraints = await this.manager.getAudioConstraints();
      const audio =
        typeof constraints?.audio === "object" && constraints.audio !== null
          ? constraints.audio
          : true;
      take.stream = await this.mediaDevices.getUserMedia({ audio });
      if (take.discarded) {
        this._release(take);
        return;
      }
      take.recorder = new MediaRecorder(take.stream);
      take.recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) take.chunks.push(event.data);
      };
      take.recorder.start();
      take.openedAt = performance.now();
      const settings = take.stream.getAudioTracks?.()[0]?.getSettings?.() || {};
      logger.info(
        "Voice answer recording started",
        {
          label: take.stream.getAudioTracks?.()[0]?.label || null,
          sampleRate: settings.sampleRate ?? null,
          openMs: Math.round(take.openedAt - take.startedAt),
          // The key came up while the microphone opened: almost nothing is recorded.
          keyAlreadyUp: take.stopping,
        },
        "audio"
      );
      this._meter(take);
      // The key came up while the microphone opened.
      if (take.stopping) void this._stop(id, { force: true });
    } catch (error) {
      this._release(take);
      if (this.current === take) this.current = null;
      this._report(id, { error: "microphone", message: String(error?.message || error) });
    }
  }

  async _stop(id, { force = false } = {}) {
    const take = this.current;
    if (!take || take.id !== id) return;
    if (take.stopping && !force) return;
    take.stopping = true;
    // Still opening the microphone: _start stops it once it is open.
    if (!take.recorder) return;
    const recorder = take.recorder;
    const flushed = new Promise((resolve) => {
      recorder.onstop = resolve;
    });
    try {
      recorder.stop();
      await flushed;
    } catch {
      // A recorder that already stopped has flushed what it had.
    }
    this._release(take);
    if (this.current === take) this.current = null;
    if (take.discarded) return;

    if (!this.isLocalOnly()) {
      this._report(id, { error: "not-local" });
      return;
    }
    const blob = new Blob(take.chunks, { type: recorder.mimeType || "audio/webm" });
    const stoppedAt = performance.now();
    const durationSeconds = (stoppedAt - take.startedAt) / 1000;
    logger.info(
      "Voice answer recording stopped",
      {
        heldSeconds: Number(durationSeconds.toFixed(2)),
        recordedSeconds: Number(((stoppedAt - (take.openedAt ?? stoppedAt)) / 1000).toFixed(2)),
        blobSize: blob.size,
        chunksCount: take.chunks.length,
      },
      "audio"
    );
    try {
      const { result } = await this.manager.runTranscription(blob, {
        source: "narrator-answer",
        durationSeconds,
        // Cleanup can be a cloud model; an answer is matched as it was said.
        skipPostProcessing: true,
        // The question's language, over the one the user picked for dictation:
        // the answer is matched against choices written in it.
        ...(take.language ? { answerLanguage: take.language } : {}),
      });
      const text = typeof result?.text === "string" ? result.text.trim() : "";
      this._report(id, { text });
    } catch (error) {
      this._report(id, {
        error: error?.message === "No audio detected" ? "no-audio" : "transcription",
      });
    }
  }

  _discard(id) {
    const take = this.current;
    if (!take || take.id !== id) return;
    take.discarded = true;
    this.current = null;
    try {
      if (take.recorder && take.recorder.state !== "inactive") take.recorder.stop();
    } catch {
      // Nothing to keep either way.
    }
    this._release(take);
  }

  /** Reads the answer's loudness while it records; without Web Audio the row just says it listens. */
  _meter(take) {
    if (!this.onLevel || typeof AudioContext === "undefined" || !take.stream) return;
    try {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(take.stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      let level = 0;
      const timer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        level = nextVoiceLevel(level, Math.sqrt(sum / samples.length));
        this.onLevel(level);
      }, LEVEL_EVERY_MS);
      take.meter = { context, timer };
    } catch {
      take.meter = null;
    }
  }

  /** Closes the microphone and lets go of the call's mute key. */
  _release(take) {
    if (take.meter) {
      clearInterval(take.meter.timer);
      void take.meter.context.close().catch(() => {});
      take.meter = null;
      this.onLevel?.(0);
    }
    take.stream?.getTracks?.().forEach((track) => track.stop());
    take.stream = null;
    if (take.muted) {
      take.muted = false;
      void Promise.resolve(this.api?.voiceMuteStop?.()).catch(() => {});
    }
  }

  /** Holds the voice call's push-to-mute key, as dictation does, when the user set one. */
  _muteCall(take) {
    if (readStorage("muteVoiceCallOnRecord") !== "true") return;
    const key = readStoredHotkey(readStorage("voiceCallMuteKey"));
    if (!key) return;
    take.muted = true;
    void Promise.resolve(this.api?.voiceMuteStart?.({ key })).catch(() => {});
  }

  _report(id, payload) {
    this.api?.narratorAnswerHeard?.({ id, ...payload });
  }
}
