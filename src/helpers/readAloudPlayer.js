/**
 * Read Aloud playback (renderer side).
 *
 * Ported from the validated Read Aloud spike. The important part
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
import {
  splitFirstChunk,
  trimSilence,
  HEAD_KEEP_LEAD_MS,
  HEAD_KEEP_TRAIL_MS,
  TAIL_KEEP_LEAD_MS,
} from "./readAloudFirstChunk";
import { DEFAULT_KOKORO_VOICE_ID } from "../models/kokoroVoices";

/** Sentences to synthesize ahead of the one playing, so seams stay gapless. */
const LOOKAHEAD = 2;

export class ReadAloudPlayer {
  constructor({
    api = null,
    voice = DEFAULT_KOKORO_VOICE_ID,
    speed = 1.0,
    disableFirstChunk,
  } = {}) {
    this.api = api || (typeof window === "undefined" ? null : window.electronAPI);
    this.voice = voice;
    this.speed = speed;
    /**
     * The A/B switch the first-audio harness needs: with chunking off, a press
     * pays for the whole first sentence again, which is the baseline the gate
     * is measured against. Set from the launch env via preload so the two
     * conditions differ only in this flag.
     */
    this.disableFirstChunk = Boolean(
      disableFirstChunk ?? this.api?.readAloudFirstChunkDisabled ?? false
    );

    /**
     * Head/tail of sentence 0 for the current press, or null when the sentence
     * is spoken whole. Deliberately not visible in getState(): the counter, the
     * sentence line and seek all stay sentence-based.
     */
    this.firstChunks = null;
    this.chunkTailAt = null;
    this.playbackWords = [];
    this.chunkCache = new Map();
    this.chunkInflight = new Map();
    /** Chunk B, scheduled ahead on the audio timeline while chunk A plays. */
    this.pendingSource = null;

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
    const ctx = this.playing ? this.getContext() : null;
    const outputTime = this.playing ? ctx?.getOutputTimestamp?.().contextTime : null;
    const elapsed =
      outputTime > 0
        ? outputTime - this.startedAt + this.offset
        : this.playing
          ? this.elapsed()
          : this.offset;
    const currentWord =
      this.status === "playing" || this.status === "paused"
        ? (this.playbackWords.find(
            (word, index) =>
              (elapsed >= word.startTime || (this.status === "paused" && index === 0)) &&
              elapsed < (this.playbackWords[index + 1]?.startTime ?? word.endTime)
          ) ?? null)
        : null;
    return {
      status: this.status,
      // The voice this player will speak with right now. The overlay rewrites
      // it from localStorage before every speak(), so this is the only place
      // that can prove the picker's choice actually reached playback.
      voice: this.voice,
      speed: this.speed,
      sentenceCount: this.sentences.length,
      index: this.index,
      // The sentence the listener is hearing right now. The overlay shows it so
      // a read has a visible place in the text rather than only a counter;
      // null before a split has produced anything to say.
      currentSentence: this.sentences[this.index] ?? null,
      currentWord,
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
    // When the first sentence was chunked there is no sentence-0 buffer to
    // report, so the stats cover the chunks decoded so far instead. That is
    // still the real audio played for sentence 0, just possibly only its head
    // if the tail has not landed yet.
    const buffers =
      entry === undefined && i === 0 && this.firstChunks
        ? ["head", "tail"].map((key) => this.chunkCache.get(key)).filter(Boolean)
        : entry
          ? [entry]
          : [];
    if (!buffers.length) return null;

    let sumSquares = 0;
    let sampleCount = 0;
    let durationSec = 0;
    let synthMs = 0;
    for (const part of buffers) {
      const data = part.buffer.getChannelData(0);
      for (let n = 0; n < data.length; n++) sumSquares += data[n] * data[n];
      sampleCount += data.length;
      durationSec += part.buffer.duration;
      synthMs += part.synthMs || 0;
    }

    return {
      durationSec,
      rms: sampleCount ? Math.sqrt(sumSquares / sampleCount) : 0,
      synthMs,
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

  async ensure(i, { priority = "interactive" } = {}) {
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
          // Queue steering for the main-process engine: the sentence being
          // waited on outranks lookahead, and a bumped epoch retires queued
          // synths from the previous press.
          priority,
          epoch,
          channel: "readaloud",
          withWordTimings: true,
        });
      })
      .then(({ pcm, sampleRate, synthMs, wordTimings = [] }) => {
        const ctx = this.getContext();
        if (!ctx) throw new Error("No AudioContext available");

        const samples = pcm instanceof Float32Array ? pcm : new Float32Array(pcm);
        const buffer = ctx.createBuffer(1, samples.length, sampleRate);
        buffer.copyToChannel(samples, 0);

        const entry = { buffer, synthMs, seconds: samples.length / sampleRate, wordTimings };
        // A synth started before the cache was invalidated must not repopulate it.
        if (epoch === this.epoch) this.cache.set(i, entry);
        this.inflight.delete(i);
        if (recordTimings) this.lastSynthMs = synthMs;
        return entry;
      })
      .catch((err) => {
        this.inflight.delete(i);
        // A synth from a superseded press (stale epoch, or any late failure
        // after the listener moved on) must not paint the current read as
        // broken.
        if (epoch === this.epoch) {
          this.error = String(err?.message || err);
          this.status = "error";
        }
        throw err;
      });

    this.inflight.set(i, job);
    return job;
  }

  /**
   * Synthesize one half of the chunked first sentence. Deliberately a sibling
   * of ensure() rather than a special index inside it: nothing that walks
   * `sentences` — the counter, seek, prefetch — must ever see a chunk.
   *
   * The recordTimings guard is the same one ensure() uses and means the same
   * thing. Chunk A is what TTFA measures, so its synthesis time is the honest
   * value for lastSynthMs; by the time chunk B starts, first audio has already
   * cleared ttfaMark, so B cannot overwrite it.
   */
  async ensureChunk(key, text) {
    if (this.chunkCache.has(key)) return this.chunkCache.get(key);
    if (this.chunkInflight.has(key)) return this.chunkInflight.get(key);

    const epoch = this.epoch;
    const recordTimings = this.ttfaMark !== 0;
    const engineWaitStarted = Date.now();
    const job = this.ensureEngine()
      .then(() => {
        if (recordTimings) this.lastEngineWaitMs = Date.now() - engineWaitStarted;
        return this.api.readAloudSynth({
          text,
          voice: this.voice,
          speed: this.speed,
          // The head is what the press is waiting on; the tail plays a
          // sentence-length later, so it queues as lookahead and cannot block
          // the next press's head.
          priority: key === "head" ? "interactive" : "prefetch",
          epoch,
          channel: "readaloud",
          withWordTimings: true,
        });
      })
      .then(({ pcm, sampleRate, synthMs, wordTimings = [] }) => {
        const ctx = this.getContext();
        if (!ctx) throw new Error("No AudioContext available");

        const raw = pcm instanceof Float32Array ? pcm : new Float32Array(pcm);
        // Kokoro pads each utterance with hundreds of ms of silence; played
        // back-to-back that padding is an audible hole in the middle of the
        // sentence. The head loses most of its lead (the press should be
        // answered by sound) and its trail; the tail loses most of its lead.
        // The tail's trailing padding stays — it is the pause before the next
        // sentence. Constants and the measurements behind them live in
        // readAloudFirstChunk.js.
        const samples =
          key === "head"
            ? trimSilence(raw, sampleRate, {
                keepLeadMs: HEAD_KEEP_LEAD_MS,
                keepTrailMs: HEAD_KEEP_TRAIL_MS,
              })
            : trimSilence(raw, sampleRate, { keepLeadMs: TAIL_KEEP_LEAD_MS, keepTrailMs: null });
        const buffer = ctx.createBuffer(1, samples.length, sampleRate);
        buffer.copyToChannel(samples, 0);

        const trimmedLead =
          (samples.byteOffset - raw.byteOffset) / Float32Array.BYTES_PER_ELEMENT / sampleRate;
        const seconds = samples.length / sampleRate;
        const entry = {
          buffer,
          synthMs,
          seconds,
          wordTimings: wordTimings
            .map((word) => ({
              ...word,
              startTime: Math.max(0, word.startTime - trimmedLead),
              endTime: Math.min(seconds, word.endTime - trimmedLead),
            }))
            .filter((word) => word.endTime > word.startTime),
        };
        if (epoch === this.epoch) this.chunkCache.set(key, entry);
        this.chunkInflight.delete(key);
        if (recordTimings) this.lastSynthMs = synthMs;
        return entry;
      })
      .catch((err) => {
        this.chunkInflight.delete(key);
        throw err;
      });

    this.chunkInflight.set(key, job);
    return job;
  }

  prefetch() {
    for (let k = 1; k <= LOOKAHEAD; k++) {
      this.ensure(this.index + k, { priority: "prefetch" })?.catch?.(() => {
        // Prefetch failures surface when that sentence is actually reached.
      });
    }
  }

  /** Resume exactly the same first-sentence audio, including its chunk seam. */
  cacheFirstSentence(head, tail) {
    const ctx = this.getContext();
    const tailAt = this.chunkTailAt ?? head.seconds;
    const rate = head.buffer.sampleRate;
    const tailSample = Math.round(tailAt * rate);
    const buffer = ctx.createBuffer(1, tailSample + tail.buffer.length, rate);
    buffer.copyToChannel(head.buffer.getChannelData(0), 0);
    buffer.copyToChannel(tail.buffer.getChannelData(0), 0, tailSample);
    const textStart = this.sentences[0].length - this.firstChunks.tail.length;
    const wordTimings = [
      ...head.wordTimings,
      ...tail.wordTimings.map((word) => ({
        ...word,
        start: word.start + textStart,
        end: word.end + textStart,
        startTime: word.startTime + tailAt,
        endTime: word.endTime + tailAt,
      })),
    ];
    const entry = {
      buffer,
      wordTimings,
      seconds: buffer.duration,
      synthMs: head.synthMs + tail.synthMs,
    };
    this.cache.set(0, entry);
    return entry;
  }

  // --------------------------------------------------------------- playback

  stopSource() {
    // Chunk B may already be scheduled on the timeline while chunk A is still
    // audible. Stopping only the audible one would let the remainder of the
    // first sentence play on after a pause, seek, or stop.
    for (const key of ["source", "pendingSource"]) {
      const src = this[key];
      if (!src) continue;
      src._cancelled = true;
      try {
        src.stop();
      } catch {
        // Already stopped, or scheduled and never started.
      }
      this[key] = null;
    }
  }

  elapsed() {
    const ctx = this.getContext();
    return this.playing && this.source && ctx
      ? ctx.currentTime - this.startedAt + this.offset
      : this.offset;
  }

  /**
   * Speak sentence 0 as head-then-tail on one audio timeline.
   *
   * Returns true when it took ownership of playback (including when a newer
   * generation superseded it mid-flight, in which case nothing must start).
   * Returns false only when the head could not be synthesized, so playFrom()
   * can fall back to the whole sentence.
   */
  async playFirstChunks(gen, ctx) {
    const chunks = this.firstChunks;
    let head;
    try {
      head = await this.ensureChunk("head", chunks.head);
    } catch {
      // A failed head is not fatal: the full sentence is still a valid read.
      return false;
    }
    if (gen !== this.generation) return true;
    if (!head) return false;

    const src = ctx.createBufferSource();
    src.buffer = head.buffer;
    src.connect(ctx.destination);
    // The tail owns the continuation to sentence 1; the head ends into it.
    src.onended = () => {};
    src.start(0);

    this.source = src;
    // Both chunks share this anchor with offset 0, so elapsed() keeps reading
    // as time into sentence 0 straight across the seam. Nothing re-anchors when
    // the tail starts, which is also why pause() lands on the right offset.
    this.startedAt = ctx.currentTime;
    this.offset = 0;
    this.playing = true;
    this.status = "playing";
    this.playbackWords = head.wordTimings;

    if (this.ttfaMark) {
      this.ttfaMs = Date.now() - this.ttfaMark;
      this.ttfaMark = 0;
    }

    // Only now, with ttfaMark cleared, does anything else get to synthesize:
    // the tail's and the prefetch's timings cannot pollute the press numbers.
    const tailStartsAt = this.startedAt + head.buffer.duration;
    this.ensureChunk("tail", chunks.tail)
      .then((tail) => {
        if (gen !== this.generation || !tail) return;

        const tailSrc = ctx.createBufferSource();
        tailSrc.buffer = tail.buffer;
        tailSrc.connect(ctx.destination);
        tailSrc.onended = () => {
          if (tailSrc._cancelled || gen !== this.generation) return;
          this.playFrom(this.index + 1, 0);
        };
        // Sample-accurate on the shared context's own clock: no onended
        // round-trip, so the seam is a continuation rather than a click.
        // Math.max only matters if synthesis overran the head, which is the
        // one case a gap is unavoidable.
        const actualStart = Math.max(ctx.currentTime, tailStartsAt);
        this.chunkTailAt = actualStart - this.startedAt;
        this.playbackWords = this.cacheFirstSentence(head, tail).wordTimings;
        tailSrc.start(actualStart);
        this.pendingSource = tailSrc;
      })
      .catch((err) => {
        if (gen !== this.generation) return;
        this.error = String(err?.message || err);
        this.status = "error";
        this.playing = false;
      });

    this.prefetch();
    return true;
  }

  async playFrom(i, off = 0, { useFirstChunks = false } = {}) {
    this.done = false;
    const gen = ++this.generation;
    this.stopSource();
    this.playing = false;
    this.playbackWords = [];

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

    // Start the first head immediately. Resumes use the cached combined audio
    // below, keeping offsets and word timings on that same waveform.
    if (useFirstChunks && this.firstChunks && this.index === 0 && this.offset === 0) {
      if (await this.playFirstChunks(gen, ctx)) return;
      if (gen !== this.generation) return;
      // The head failed; fall through and read sentence 0 whole.
      this.firstChunks = null;
    }

    let entry;
    try {
      if (this.index === 0 && this.firstChunks && !this.cache.has(0)) {
        const head = await this.ensureChunk("head", this.firstChunks.head);
        const tail = await this.ensureChunk("tail", this.firstChunks.tail);
        if (gen !== this.generation) return;
        entry = this.cacheFirstSentence(head, tail);
      } else {
        entry = await this.ensure(this.index);
      }
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
    this.playbackWords = entry.wordTimings ?? [];

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
    this.firstChunks = null;
    this.chunkTailAt = null;
    this.playbackWords = [];
    this.chunkCache.clear();
    this.chunkInflight.clear();
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

    if (!this.disableFirstChunk) {
      this.firstChunks = splitFirstChunk(this.sentences[0]);
    }

    await this.playFrom(0, 0, { useFirstChunks: true });
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.elapsed();
    this.generation++;
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
      this.playbackWords = this.cache.get(target)?.wordTimings ?? [];
      const gen = ++this.generation;
      this.ensure(this.index)
        ?.then?.((entry) => {
          if (gen === this.generation) this.playbackWords = entry.wordTimings;
        })
        .catch?.(() => {});
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
    this.firstChunks = null;
    this.chunkTailAt = null;
    this.playbackWords = [];
    this.chunkCache.clear();
    this.chunkInflight.clear();
  }

  dispose() {
    this.stop();
    this.clearCache();
    this.sentences = [];
    this.status = "idle";
  }
}

export default ReadAloudPlayer;
