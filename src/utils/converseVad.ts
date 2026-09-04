/**
 * Voice activity detection for the Converse loop.
 *
 * A hands-free conversation needs one decision made over and over: has the
 * person started talking, and have they finished. Everything here is that
 * decision and nothing else — no audio, no timers, no browser. The hook feeds
 * it microphone RMS readings and a clock, and it answers with events, so the
 * behaviour that decides when a turn is sent can be tested without a
 * microphone.
 *
 * The threshold is the one dictation already uses (see speechPresence.ts): the
 * lower of an absolute floor that is speech on any microphone and a bar well
 * above the room's own noise. It is recomputed from the recent quiet, so a
 * noisy room raises the bar instead of talking to itself.
 */

import {
  SPEECH_ABSOLUTE_RMS,
  SPEECH_DYNAMIC_MIN_RMS,
  SPEECH_DYNAMIC_RATIO,
} from "./speechPresence";

/** How often the hook samples the microphone. 25 readings a second. */
export const VAD_POLL_MS = 40;

/**
 * Sound has to last this long to be a word. A single key click or a desk knock
 * is shorter, and starting a turn on one would interrupt the agent for nothing.
 */
export const VAD_ONSET_MS = 160;

/** Pause that ends a turn, when the user has not chosen one. */
export const VAD_DEFAULT_END_OF_TURN_MS = 900;

/** The three pauses the page offers, in the order they are shown. */
export const END_OF_TURN_CHOICES = [
  { value: 600, label: "Quick", detail: "Sends after a short pause" },
  { value: VAD_DEFAULT_END_OF_TURN_MS, label: "Natural", detail: "Room to think mid-sentence" },
  { value: 1600, label: "Relaxed", detail: "Long pauses stay part of the same turn" },
] as const;

/**
 * Speech shorter than this is thrown away rather than transcribed. Whisper
 * answers a cough with an invented phrase, and in a hands-free loop that
 * invented phrase would be sent to the agent unread.
 */
export const VAD_MIN_UTTERANCE_MS = 400;

/** A turn is cut here whatever happens, so a stuck-open microphone still sends. */
export const VAD_MAX_UTTERANCE_MS = 60_000;

/**
 * Readings kept for the noise floor, taken only while nobody is speaking.
 * At VAD_POLL_MS that is about four seconds of room tone.
 */
export const VAD_NOISE_WINDOW = 100;

/** Enough of the window filled to trust its median as the room's noise floor. */
const VAD_NOISE_MIN_READINGS = 12;

export type VadEvent =
  | null
  /** Someone started talking. */
  | "speech-start"
  /** They stopped, and what they said is long enough to transcribe. */
  | "speech-end"
  /** They stopped, and it was too short to be a sentence — discard it. */
  | "speech-discarded";

export interface VadOptions {
  /** Silence that ends a turn. */
  endOfTurnMs?: number;
  /** Sound that has to persist before a turn starts. */
  onsetMs?: number;
  minUtteranceMs?: number;
  maxUtteranceMs?: number;
}

export class VoiceActivityDetector {
  private readonly onsetMs: number;
  private readonly minUtteranceMs: number;
  private readonly maxUtteranceMs: number;
  private endOfTurnMs: number;

  private noise: number[] = [];
  private speaking = false;
  private aboveSince: number | null = null;
  private belowSince: number | null = null;
  private startedAt: number | null = null;
  private lastLoudAt: number | null = null;

  constructor({
    endOfTurnMs = VAD_DEFAULT_END_OF_TURN_MS,
    onsetMs = VAD_ONSET_MS,
    minUtteranceMs = VAD_MIN_UTTERANCE_MS,
    maxUtteranceMs = VAD_MAX_UTTERANCE_MS,
  }: VadOptions = {}) {
    this.endOfTurnMs = endOfTurnMs;
    this.onsetMs = onsetMs;
    this.minUtteranceMs = minUtteranceMs;
    this.maxUtteranceMs = maxUtteranceMs;
  }

  /** Change the end-of-turn pause without losing the learned noise floor. */
  setEndOfTurnMs(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) this.endOfTurnMs = ms;
  }

  /** Mid-turn state only. The noise floor is knowledge about the room, and survives. */
  reset(): void {
    this.speaking = false;
    this.aboveSince = null;
    this.belowSince = null;
    this.startedAt = null;
    this.lastLoudAt = null;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** When the current turn's first sound was heard, or null between turns. */
  get speechStartedAt(): number | null {
    return this.startedAt;
  }

  /**
   * The bar a reading has to clear right now. Falls back to the absolute floor
   * until enough quiet has been measured to know the room.
   */
  get threshold(): number {
    if (this.noise.length < VAD_NOISE_MIN_READINGS) return SPEECH_ABSOLUTE_RMS;
    const sorted = [...this.noise].sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length / 2)];
    const dynamic = Math.max(floor * SPEECH_DYNAMIC_RATIO, SPEECH_DYNAMIC_MIN_RMS);
    return Math.min(SPEECH_ABSOLUTE_RMS, dynamic);
  }

  /**
   * One microphone reading.
   *
   * @param rms  level in 0..1, or null when the level could not be read at all
   *             (a suspended AudioContext). Unreadable is not silence: it is
   *             ignored, so a suspended context can never end a turn on its own.
   * @param atMs monotonic-ish timestamp for this reading.
   */
  push(rms: number | null, atMs: number): VadEvent {
    if (rms === null || !Number.isFinite(rms) || rms < 0) return null;

    const loud = rms >= this.threshold;

    if (!this.speaking) {
      // The floor is learned from the quiet only, so a long sentence cannot
      // raise the bar until the speaker is inaudible.
      if (!loud) {
        this.noise.push(rms);
        if (this.noise.length > VAD_NOISE_WINDOW) this.noise.shift();
        this.aboveSince = null;
        return null;
      }

      if (this.aboveSince === null) this.aboveSince = atMs;
      if (atMs - this.aboveSince < this.onsetMs) return null;

      this.speaking = true;
      // Stamped at the first loud reading, not at the one that confirmed it:
      // the recording that gets transcribed has to include the whole word.
      this.startedAt = this.aboveSince;
      this.lastLoudAt = atMs;
      this.belowSince = null;
      this.aboveSince = null;
      return "speech-start";
    }

    if (loud) {
      this.lastLoudAt = atMs;
      this.belowSince = null;
    } else if (this.belowSince === null) {
      this.belowSince = atMs;
    }

    const heldTooLong = this.startedAt !== null && atMs - this.startedAt >= this.maxUtteranceMs;
    const paused = this.belowSince !== null && atMs - this.belowSince >= this.endOfTurnMs;
    if (!paused && !heldTooLong) return null;

    // Measured to the last loud reading, so the trailing pause is not counted
    // as speech and a 100ms cough cannot pass as a sentence.
    const spokenMs = (this.lastLoudAt ?? atMs) - (this.startedAt ?? atMs);
    this.reset();
    return spokenMs >= this.minUtteranceMs ? "speech-end" : "speech-discarded";
  }
}
