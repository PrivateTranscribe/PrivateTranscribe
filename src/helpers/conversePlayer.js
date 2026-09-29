/**
 * Converse playback (renderer side).
 *
 * Ported from the validated voice-loop spike's renderer/app.js. It is the Read
 * Aloud generation-counter engine rewritten
 * for a queue that arrives one sentence at a time from a live agent stream,
 * instead of a fixed list produced by splitting a finished document.
 *
 * ReadAloudPlayer is deliberately left alone: seek/pause over a known sentence
 * list and an open-ended queue that may still be growing are different enough
 * that folding both into one class costs more than a sibling does.
 *
 * Synthesis is the same main-process Kokoro engine (`readAloudSynth`); this
 * file only turns PCM into AudioBuffers, schedules them, and reports where
 * playback actually is so the main-process session can move its state machine.
 */

import { getSharedAudioContext, waitForAudioContextRunning } from "../utils/sharedAudioContext";
import { DEFAULT_KOKORO_VOICE_ID } from "../models/kokoroVoices";

/** Sentences to synthesize ahead of the one playing, so seams stay gapless. */
const LOOKAHEAD = 2;

export class ConversePlayer {
  /**
   * `resolveVoice` is read at the start of every turn rather than once at
   * construction. The picker lives in the control panel and this player lives
   * in the overlay, which may have been running since before that window
   * existed — so the choice is pulled at the one instant it is needed. A turn
   * boundary is also the only safe moment to switch: the buffers already
   * synthesized for the turn in flight are in the old voice, and swapping
   * mid-answer would change speaker mid-sentence.
   */
  constructor({ api = null, voice = DEFAULT_KOKORO_VOICE_ID, speed = 1.0, resolveVoice } = {}) {
    this.api = api || (typeof window === "undefined" ? null : window.electronAPI);
    this.voice = voice;
    this.resolveVoice = typeof resolveVoice === "function" ? resolveVoice : null;
    this.speed = speed;

    /** Turn generation this queue belongs to; -1 until the first sentence. */
    this.gen = -1;
    this.texts = [];
    this.cache = new Map();
    this.inflight = new Map();
    this.playIndex = 0;
    /** True only while a buffer source is actually running. */
    this.playing = false;
    /**
     * Reentrancy guard for playFrom(). Separate from `playing` on purpose: the
     * session treats `playing` as proof that audio reached the speakers, so it
     * must not be set while a sentence is still being synthesized.
     */
    this.busy = false;
    this.total = null;
    this.drainedSent = false;
    this.source = null;
    this.lastSynthMs = null;
    this.error = null;

    this.unsubscribes = [];
  }

  // ------------------------------------------------------------------ wiring

  /** Subscribe to the main-process session. Safe to call once per mount. */
  connect() {
    if (!this.api) return;
    const add = (fn) => {
      if (typeof fn === "function") this.unsubscribes.push(fn);
    };
    add(this.api.onConverseSentence?.((_event, msg) => this.handleSentence(msg)));
    add(this.api.onConverseTurnEnd?.((_event, msg) => this.handleTurnEnd(msg)));
    add(this.api.onConverseInterrupt?.((_event, msg) => this.handleInterrupt(msg)));
  }

  dispose() {
    for (const off of this.unsubscribes) {
      try {
        off();
      } catch {
        // Listener already removed.
      }
    }
    this.unsubscribes = [];
    this.stopSource();
    this.cache.clear();
    this.inflight.clear();
  }

  getState() {
    return {
      gen: this.gen,
      // Reported so a bug report says which voice actually spoke, not which one
      // the control panel showed at the time it was filed.
      voice: this.voice,
      playing: this.playing,
      playIndex: this.playIndex,
      known: this.texts.filter((t) => t !== undefined).length,
      total: this.total,
      cached: this.cache.size,
      drained: this.drainedSent,
      lastSynthMs: this.lastSynthMs,
      error: this.error,
    };
  }

  /** Push the current position to the main process; it owns the state machine. */
  report() {
    this.api?.converseReportPlayerState?.(this.getState());
  }

  // ------------------------------------------------------------------- queue

  handleSentence(msg) {
    if (!msg || typeof msg.index !== "number") return;
    if (msg.gen !== this.gen) this.resetTo(msg.gen);
    this.texts[msg.index] = msg.text;
    if (msg.index <= this.playIndex + LOOKAHEAD) {
      this.ensure(msg.index, {
        priority: msg.index === this.playIndex ? "interactive" : "prefetch",
      });
    }
    this.report();
    if (!this.busy) this.playFrom(this.playIndex);
  }

  handleTurnEnd(msg) {
    if (!msg || msg.gen !== this.gen) return;
    this.total = msg.total;
    if (!this.busy && this.playIndex >= this.total) this.drain();
    this.report();
  }

  handleInterrupt(msg) {
    if (!msg) return;
    this.resetTo(msg.gen);
  }

  resetTo(newGen) {
    this.gen = newGen;
    // New turn, empty cache: the moment to pick up a voice change made in the
    // control panel since the last answer.
    if (this.resolveVoice) {
      try {
        const next = this.resolveVoice();
        if (next) this.voice = next;
      } catch {
        // Keep speaking with the voice we already have.
      }
    }
    this.stopSource();
    this.texts = [];
    this.cache.clear();
    this.inflight.clear();
    this.playIndex = 0;
    this.playing = false;
    this.busy = false;
    this.total = null;
    this.drainedSent = false;
    this.error = null;
    this.report();
  }

  // --------------------------------------------------------------- synthesis

  ensure(i, { priority = "interactive" } = {}) {
    if (i < 0 || this.texts[i] === undefined) return null;
    if (this.cache.has(i)) return Promise.resolve(this.cache.get(i));
    if (this.inflight.has(i)) return this.inflight.get(i);

    const myGen = this.gen;
    const job = Promise.resolve(
      this.api.readAloudSynth({
        text: this.texts[i],
        voice: this.voice,
        speed: this.speed,
        // The sentence being waited on outranks lookahead in the engine queue,
        // and an interrupt's gen bump retires the dead turn's queued synths.
        priority,
        epoch: myGen,
        channel: "converse",
      })
    )
      .then(({ pcm, sampleRate, synthMs }) => {
        const ctx = getSharedAudioContext();
        if (!ctx) throw new Error("No AudioContext available");

        const samples = pcm instanceof Float32Array ? pcm : new Float32Array(pcm);
        const buffer = ctx.createBuffer(1, samples.length, sampleRate);
        buffer.copyToChannel(samples, 0);

        const entry = { buffer, synthMs, seconds: samples.length / sampleRate };
        // A synth that resolves after an interrupt must not repopulate the queue.
        if (myGen === this.gen) this.cache.set(i, entry);
        this.inflight.delete(i);
        this.lastSynthMs = synthMs;
        return entry;
      })
      .catch((err) => {
        this.inflight.delete(i);
        // A synth from an interrupted turn (stale epoch) failing late must not
        // mark the live turn as broken.
        if (myGen === this.gen) this.error = String(err?.message || err);
        return null;
      });

    this.inflight.set(i, job);
    return job;
  }

  prefetch() {
    for (let k = 1; k <= LOOKAHEAD; k++) this.ensure(this.playIndex + k, { priority: "prefetch" });
  }

  // ---------------------------------------------------------------- playback

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
    this.playing = false;
  }

  drain() {
    if (this.drainedSent) return;
    this.drainedSent = true;
    this.report();
  }

  async playFrom(i) {
    const myGen = this.gen;
    if (this.texts[i] === undefined) {
      // Either the agent has not produced this sentence yet, or the stream is
      // over and the turn is finished.
      this.busy = false;
      if (this.total !== null && i >= this.total) this.drain();
      return;
    }

    this.busy = true;
    this.playIndex = i;
    this.report();

    const ctx = getSharedAudioContext();
    if (!ctx) {
      this.error = "No AudioContext available";
      this.busy = false;
      this.report();
      return;
    }
    if (ctx.state === "suspended") await waitForAudioContextRunning(ctx);
    if (myGen !== this.gen) return;

    const entry = await this.ensure(i);
    if (myGen !== this.gen) return;
    if (!entry) {
      // Synthesis failed for this sentence; skip it rather than stalling the turn.
      this.playFrom(i + 1);
      return;
    }

    const src = ctx.createBufferSource();
    src.buffer = entry.buffer;
    src.connect(ctx.destination);
    src.onended = () => {
      if (src._cancelled || myGen !== this.gen) return;
      this.playing = false;
      this.playFrom(i + 1);
    };
    src.start(0);
    this.source = src;
    this.playing = true;

    this.prefetch();
    this.report();
  }
}

export default ConversePlayer;
