/**
 * Read Aloud playback (renderer side).
 *
 * Ported from the validated spike at C:\tmp\readaloud-spike. The important part
 * is the generation counter: `index` and `offset` are the only truth about
 * where playback is, and every async continuation captures the generation it
 * started under. Anything that lands after a seek, pause, or new speak() is
 * dropped instead of being allowed to restart audio the user already left.
 * Without it, a synthesis that resolves late resumes a sentence the listener
 * skipped past — which is exactly the bug Narrator has.
 *
 * Synthesis happens in the main process (Kokoro / onnxruntime-node); this file
 * only turns PCM into AudioBuffers and schedules them.
 */

import { getSharedAudioContext, waitForAudioContextRunning } from "../utils/sharedAudioContext";

/** Sentences to synthesize ahead of the one playing, so seams stay gapless. */
const LOOKAHEAD = 2;
const DEFAULT_VOICE = "af_heart";

export class ReadAloudPlayer {
  constructor({ api = null, voice = DEFAULT_VOICE, speed = 1.0 } = {}) {
    this.api = api || (typeof window === "undefined" ? null : window.electronAPI);
    this.voice = voice;
    this.speed = speed;

    this.sentences = [];
    this.cache = new Map();
    this.inflight = new Map();

    this.index = 0;
    this.offset = 0;
    this.source = null;
    this.playing = false;
    this.done = false;
    this.startedAt = 0;
    this.generation = 0;
    /** Bumped whenever the cache is invalidated, so late synths cannot write into it. */
    this.epoch = 0;

    this.ttfaMark = 0;
    this.ttfaMs = null;
    this.lastSynthMs = null;
    // Stage timings for the most recent speak(), so the trigger-lag harness can
    // split "waiting for the engine" from "synthesizing" from "everything else".
    this.splitMs = null;
    this.lastEngineWaitMs = null;
    this.lastCtxWaitMs = null;

    this.engineLoaded = false;
    this.enginePromise = null;
    this.status = "idle";
    this.error = null;
  }

  // ------------------------------------------------------------------ state

  getState() {
    return {
      status: this.status,
      // The voice this player will speak with right now. The overlay rewrites
      // it from localStorage before every speak(), so this is the only place
      // that can prove the picker's choice actually reached playback.
      voice: this.voice,
      sentenceCount: this.sentences.length,
      index: this.index,
      // The sentence the listener is hearing right now. The overlay shows it so
      // a read has a visible place in the text rather than only a counter;
      // null before a split has produced anything to say.
      currentSentence: this.sentences[this.index] ?? null,
      offset: this.offset,
      playing: this.playing,
      ttfaMs: this.ttfaMs,
      lastSynthMs: this.lastSynthMs,
      splitMs: this.splitMs,
      lastEngineWaitMs: this.lastEngineWaitMs,
      lastCtxWaitMs: this.lastCtxWaitMs,
      lastEngineLoadReply: this.lastEngineLoadReply ?? null,
      engineLoaded: this.engineLoaded,
      error: this.error,
    };
  }

  /**
   * Decoded stats for one sentence, used to prove the audio is real rather than
   * a fast-but-silent buffer. Returns null if that sentence is not synthesized.
   */
  getBufferStats(i = 0) {
    const entry = this.cache.get(i);
    if (!entry) return null;

    const data = entry.buffer.getChannelData(0);
    let sumSquares = 0;
    for (let n = 0; n < data.length; n++) sumSquares += data[n] * data[n];

    return {
      durationSec: entry.buffer.duration,
      rms: data.length ? Math.sqrt(sumSquares / data.length) : 0,
      synthMs: entry.synthMs,
    };
  }

  // ----------------------------------------------------------------- engine

  getContext() {
    return getSharedAudioContext();
  }

  async ensureEngine() {
    if (this.engineLoaded) return;
    if (this.enginePromise) return this.enginePromise;

    this.status = "loading-engine";
    this.enginePromise = Promise.resolve(this.api?.readAloudLoadEngine?.())
      .then((status) => {
        // Kept verbatim for the trigger-lag harness: a load that resolves
        // suspiciously fast shows its answer here instead of being guessed at.
        this.lastEngineLoadReply = status === undefined ? "undefined" : JSON.stringify(status);
        this.engineLoaded = Boolean(status?.loaded ?? true);
        this.enginePromise = null;
      })
      .catch((err) => {
        this.enginePromise = null;
        this.error = String(err?.message || err);
        this.status = "error";
        throw err;
      });

    return this.enginePromise;
  }

  // -------------------------------------------------------------- synthesis

  async ensure(i) {
    if (i < 0 || i >= this.sentences.length) return null;
    if (this.cache.has(i)) return this.cache.get(i);
    if (this.inflight.has(i)) return this.inflight.get(i);

    const epoch = this.epoch;
    // Stage timings are only recorded for the sentence TTFA measures - the one
    // in flight while ttfaMark is armed. Without this guard, prefetch()'s
    // warm-engine ensure() calls land right after first audio and overwrite
    // the numbers with zeros before anyone reads them.
    const recordTimings = this.ttfaMark !== 0;
    const engineWaitStarted = Date.now();
    const job = this.ensureEngine()
      .then(() => {
        // How long this sentence sat waiting for the engine. ~0 once the engine
        // is warm, the whole 326MB load when it is not - which is the number
        // the trigger-lag gate exists to drive down.
        if (recordTimings) this.lastEngineWaitMs = Date.now() - engineWaitStarted;
        return this.api.readAloudSynth({
          text: this.sentences[i],
          voice: this.voice,
          speed: this.speed,
        });
      })
      .then(({ pcm, sampleRate, synthMs }) => {
        const ctx = this.getContext();
        if (!ctx) throw new Error("No AudioContext available");

        const samples = pcm instanceof Float32Array ? pcm : new Float32Array(pcm);
        const buffer = ctx.createBuffer(1, samples.length, sampleRate);
        buffer.copyToChannel(samples, 0);

        const entry = { buffer, synthMs, seconds: samples.length / sampleRate };
        // A synth started before the cache was invalidated must not repopulate it.
        if (epoch === this.epoch) this.cache.set(i, entry);
        this.inflight.delete(i);
        if (recordTimings) this.lastSynthMs = synthMs;
        return entry;
      })
      .catch((err) => {
        this.inflight.delete(i);
        this.error = String(err?.message || err);
        this.status = "error";
        throw err;
      });

    this.inflight.set(i, job);
    return job;
  }

  prefetch() {
    for (let k = 1; k <= LOOKAHEAD; k++) {
      this.ensure(this.index + k)?.catch?.(() => {
        // Prefetch failures surface when that sentence is actually reached.
      });
    }
  }

  // --------------------------------------------------------------- playback

  stopSource() {
    if (this.source) {
      this.source._cancelled = true;
      try {
        this.source.stop();
      } catch {
        // Already stopped.
      }
      this.source = null;
    }
  }

  elapsed() {
    const ctx = this.getContext();
    return this.playing && this.source && ctx
      ? ctx.currentTime - this.startedAt + this.offset
      : this.offset;
  }

  async playFrom(i, off = 0) {
    this.done = false;
    const gen = ++this.generation;
    this.stopSource();

    if (i >= this.sentences.length) {
      this.finish();
      return;
    }

    this.index = Math.max(0, i);
    this.offset = off;

    const ctx = this.getContext();
    if (!ctx) {
      this.error = "No AudioContext available";
      this.status = "error";
      return;
    }
    if (ctx.state === "suspended") {
      // On a cold overlay the shared context can take visible time to start;
      // timing it keeps the trigger-lag decomposition honest.
      const ctxWaitStarted = Date.now();
      await waitForAudioContextRunning(ctx);
      this.lastCtxWaitMs = Date.now() - ctxWaitStarted;
    }
    if (gen !== this.generation) return;

    if (!this.cache.has(this.index)) this.status = "synthesizing";

    let entry;
    try {
      entry = await this.ensure(this.index);
    } catch {
      return; // status/error already set by ensure()
    }
    if (gen !== this.generation || !entry) return;

    const src = ctx.createBufferSource();
    src.buffer = entry.buffer;
    src.connect(ctx.destination);
    src.onended = () => {
      if (src._cancelled || gen !== this.generation) return;
      this.playFrom(this.index + 1, 0);
    };
    src.start(0, Math.max(0, Math.min(this.offset, entry.buffer.duration - 0.01)));

    this.source = src;
    this.startedAt = ctx.currentTime;
    this.playing = true;
    this.status = "playing";

    if (this.ttfaMark) {
      this.ttfaMs = Date.now() - this.ttfaMark;
      this.ttfaMark = 0;
    }

    this.prefetch();
  }

  async speak(text) {
    this.ttfaMark = Date.now();
    this.ttfaMs = null;
    this.splitMs = null;
    this.lastEngineWaitMs = null;
    this.lastCtxWaitMs = null;
    this.generation++;
    this.epoch++;
    this.stopSource();
    this.playing = false;
    this.cache.clear();
    this.inflight.clear();
    this.error = null;

    this.status = "splitting";
    try {
      this.sentences = await this.api.readAloudSplit(text);
    } catch (err) {
      // Surfaced through getState() rather than thrown: callers are hotkeys and
      // click handlers with nowhere to put a rejection.
      this.error = String(err?.message || err);
      this.status = "error";
      return;
    }
    this.index = 0;
    this.offset = 0;
    this.splitMs = Date.now() - this.ttfaMark;

    await this.playFrom(0, 0);
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.elapsed();
    this.playing = false;
    this.stopSource();
    this.status = "paused";
  }

  resume() {
    if (this.playing || !this.sentences.length) return;
    this.playFrom(this.index, this.offset);
  }

  toggle() {
    if (!this.sentences.length) return;
    if (this.playing) this.pause();
    else this.playFrom(this.index, this.offset);
  }

  seek(delta) {
    if (!this.sentences.length) return;
    const target = Math.min(Math.max(this.index + delta, 0), this.sentences.length - 1);
    if (this.playing) {
      this.playFrom(target, 0);
    } else {
      this.index = target;
      this.offset = 0;
      this.ensure(this.index)?.catch?.(() => {});
      this.prefetch();
    }
  }

  finish() {
    this.done = true;
    this.playing = false;
    this.stopSource();
    this.status = "finished";
  }

  stop() {
    this.done = false;
    this.generation++;
    this.stopSource();
    this.playing = false;
    this.index = 0;
    this.offset = 0;
    this.status = "stopped";
  }

  clearCache() {
    this.epoch++;
    this.cache.clear();
    this.inflight.clear();
  }

  dispose() {
    this.stop();
    this.clearCache();
    this.sentences = [];
    this.status = "idle";
  }
}

export default ReadAloudPlayer;
