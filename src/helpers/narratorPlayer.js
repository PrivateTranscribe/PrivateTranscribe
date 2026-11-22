/**
 * Narrator playback (overlay renderer side).
 *
 * The main process streams an item while it is made: "begin" (with or without
 * the chime), one "part" per sentence, then "end". Each part is scheduled on
 * the shared AudioContext right after the one before it, so the first sentence
 * plays while the rest are still being made. Main hears "started" when the
 * first sound plays, then "done" when the last one ends, or "stopped" when
 * something cut it off. One job at a time: a new job stops the old one.
 *
 * The chime is two rising tones with silence around them, after VoiceMode's
 * feedback chimes: the silence lets a Bluetooth headset wake before the first
 * tone instead of swallowing it.
 */

import { getSharedAudioContext, waitForAudioContextRunning } from "../utils/sharedAudioContext";

const CHIME_LEAD_S = 0.1;
const CHIME_TAIL_S = 0.2;
const CHIME_TONES = [
  { frequency: 660, seconds: 0.11 },
  { frequency: 880, seconds: 0.14 },
];
const CHIME_GAIN = 0.12;
/** A sentence that arrives after the one before it ended starts this soon. */
const PART_LEAD_S = 0.05;
/** Longest wait for a dictation in progress to end before speaking anyway. */
const HOLD_MAX_MS = 60_000;
const HOLD_POLL_MS = 250;

/** Schedules the chime from `start`; returns its nodes and when it ends. */
function scheduleChime(context, start) {
  let at = start;
  const nodes = [];
  for (const tone of CHIME_TONES) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = tone.frequency;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(CHIME_GAIN, at + 0.01);
    gain.gain.linearRampToValueAtTime(0, at + tone.seconds);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(at);
    oscillator.stop(at + tone.seconds + 0.02);
    nodes.push(oscillator);
    at += tone.seconds;
  }
  return { nodes, end: at };
}

export class NarratorPlayer {
  /**
   * @param {object} opts
   * @param {object} [opts.api]          window.electronAPI
   * @param {() => boolean} [opts.holdWhile]  true while speech must wait (the user is dictating)
   * @param {(playing: boolean) => void} [opts.onPlayingChange]
   */
  constructor({ api, holdWhile = () => false, onPlayingChange = () => {} } = {}) {
    this.api = api || (typeof window === "undefined" ? null : window.electronAPI);
    this.holdWhile = holdWhile;
    this.onPlayingChange = onPlayingChange;
    /** The job playing or held, or null. */
    this.job = null;
    this.playing = false;
  }

  /** One message from main: begin, part, end or cancel. */
  handle(message) {
    if (!message?.jobId) return;
    if (message.type === "begin") {
      void this._begin(message);
      return;
    }
    const job = this.job;
    if (!job || job.id !== message.jobId) return;
    if (message.type === "part") {
      job.parts.push(message);
      this._schedule(job);
    } else if (message.type === "end") {
      job.ended = true;
      this._finishIfDone(job);
    } else if (message.type === "cancel") {
      this.stop();
    }
  }

  async _begin({ jobId, chime }) {
    this.stop();
    const job = {
      id: jobId,
      parts: [],
      ended: false,
      context: null,
      at: 0,
      nodes: [],
      live: 0,
      started: false,
    };
    this.job = job;
    this._setPlaying(true);

    const heldSince = Date.now();
    while (this.holdWhile() && Date.now() - heldSince < HOLD_MAX_MS) {
      await new Promise((resolve) => setTimeout(resolve, HOLD_POLL_MS));
      if (this.job !== job) return;
    }

    const context = getSharedAudioContext();
    if (!context) {
      this._finish(job, "done");
      return;
    }
    await waitForAudioContextRunning(context);
    if (this.job !== job) return;
    job.context = context;
    job.at = context.currentTime + CHIME_LEAD_S;
    if (chime) {
      const { nodes, end } = scheduleChime(context, job.at);
      nodes.forEach((node) => this._track(job, node));
      job.at = end + CHIME_TAIL_S;
      this._markStarted(job);
    }
    this._schedule(job);
    this._finishIfDone(job);
  }

  /** Schedules the parts that arrived, each after the one before it. */
  _schedule(job) {
    if (this.job !== job || !job.context) return;
    const context = job.context;
    for (const part of job.parts.splice(0)) {
      if (!part.pcm?.length) continue;
      const pcm = part.pcm instanceof Float32Array ? part.pcm : Float32Array.from(part.pcm);
      const buffer = context.createBuffer(1, pcm.length, part.sampleRate);
      buffer.copyToChannel(pcm, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const at = Math.max(job.at, context.currentTime + PART_LEAD_S);
      source.start(at);
      job.at = at + buffer.duration;
      this._track(job, source);
      this._markStarted(job);
    }
  }

  _track(job, node) {
    job.live += 1;
    job.nodes.push(node);
    node.onended = () => {
      job.live -= 1;
      this._finishIfDone(job);
    };
  }

  _markStarted(job) {
    if (job.started) return;
    job.started = true;
    this._report(job.id, "started");
  }

  _finishIfDone(job) {
    if (this.job === job && job.context && job.ended && job.live === 0) this._finish(job, "done");
  }

  _finish(job, state) {
    if (this.job !== job) return;
    this.job = null;
    this._setPlaying(false);
    this._report(job.id, state);
  }

  _report(jobId, state) {
    this.api?.narratorReportPlayback?.({ jobId, state });
  }

  _setPlaying(playing) {
    if (this.playing === playing) return;
    this.playing = playing;
    this.onPlayingChange(playing);
  }

  /** Silence now. The job in flight, if any, is reported as stopped. */
  stop() {
    const job = this.job;
    if (!job) return;
    this.job = null;
    for (const node of job.nodes) {
      try {
        node.onended = null;
        node.stop();
      } catch {
        // Not started yet or already ended.
      }
    }
    this._setPlaying(false);
    this._report(job.id, "stopped");
  }
}
