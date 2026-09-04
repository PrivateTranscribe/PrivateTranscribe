import { describe, expect, test } from "vitest";
import {
  VAD_DEFAULT_END_OF_TURN_MS,
  VAD_MAX_UTTERANCE_MS,
  VAD_POLL_MS,
  VoiceActivityDetector,
  type VadEvent,
} from "../../../src/utils/converseVad";

/**
 * The hands-free loop decides when a spoken turn is over. Getting that wrong is
 * not cosmetic: too eager and half a sentence is sent to the agent, too slow and
 * the conversation stalls, too twitchy and a keyboard click interrupts a reply.
 *
 * The detector is fed levels at a fixed rate, exactly as the hook does with the
 * microphone, so every case here is a room the user could actually be in.
 */

/** Ordinary speech, comfortably above any threshold. */
const SPEECH = 0.12;
/** A quiet room: audible to the analyser, never a word. */
const ROOM_TONE = 0.0006;

type Feed = { rms: number | null; ms: number };

/** Play a level for a duration and collect everything the detector answered. */
function play(vad: VoiceActivityDetector, steps: Feed[], startAt = 1000): VadEvent[] {
  const events: VadEvent[] = [];
  let at = startAt;
  for (const step of steps) {
    const frames = Math.round(step.ms / VAD_POLL_MS);
    for (let i = 0; i < frames; i += 1) {
      at += VAD_POLL_MS;
      const event = vad.push(step.rms, at);
      if (event) events.push(event);
    }
  }
  return events;
}

/** Long enough for the noise floor to be learned from the room, as in real use. */
const settle = (rms = ROOM_TONE, ms = 5000): Feed => ({ rms, ms });

describe("VoiceActivityDetector", () => {
  test("an empty room is never a turn", () => {
    const vad = new VoiceActivityDetector();
    expect(play(vad, [settle(ROOM_TONE, 30_000)])).toEqual([]);
    expect(vad.isSpeaking).toBe(false);
  });

  test("a spoken sentence starts a turn and the pause after it sends", () => {
    const vad = new VoiceActivityDetector();
    const events = play(vad, [
      settle(),
      { rms: SPEECH, ms: 2000 },
      { rms: ROOM_TONE, ms: VAD_DEFAULT_END_OF_TURN_MS + 200 },
    ]);
    expect(events).toEqual(["speech-start", "speech-end"]);
  });

  test("a pause shorter than the setting keeps the turn open", () => {
    const vad = new VoiceActivityDetector();
    const events = play(vad, [
      settle(),
      { rms: SPEECH, ms: 1200 },
      // Thinking mid-sentence. The turn must survive it.
      { rms: ROOM_TONE, ms: VAD_DEFAULT_END_OF_TURN_MS - 300 },
      { rms: SPEECH, ms: 1200 },
    ]);
    expect(events).toEqual(["speech-start"]);
    expect(vad.isSpeaking).toBe(true);
  });

  test("a keyboard click never starts a turn", () => {
    const vad = new VoiceActivityDetector();
    const events = play(vad, [
      settle(),
      // One frame of a loud knock, then quiet again: shorter than the onset.
      { rms: 0.4, ms: VAD_POLL_MS },
      { rms: ROOM_TONE, ms: 3000 },
    ]);
    expect(events).toEqual([]);
  });

  test("a cough is heard, then thrown away rather than transcribed", () => {
    const vad = new VoiceActivityDetector();
    const events = play(vad, [
      settle(),
      // Past the onset, so the loop does treat it as someone speaking and cuts
      // the reply off — but too short to be a sentence worth sending.
      { rms: 0.3, ms: 240 },
      { rms: ROOM_TONE, ms: VAD_DEFAULT_END_OF_TURN_MS + 200 },
    ]);
    expect(events).toEqual(["speech-start", "speech-discarded"]);
  });

  test("the turn ends the moment the chosen pause elapses, not before", () => {
    const vad = new VoiceActivityDetector({ endOfTurnMs: 600 });
    const started = play(vad, [settle(), { rms: SPEECH, ms: 1000 }, { rms: ROOM_TONE, ms: 400 }]);
    expect(started).toEqual(["speech-start"]);

    const ended = play(vad, [{ rms: ROOM_TONE, ms: 400 }], 100_000);
    expect(ended).toEqual(["speech-end"]);
  });

  test("a changed pause applies to the turn already in progress", () => {
    const vad = new VoiceActivityDetector({ endOfTurnMs: 1600 });
    play(vad, [settle(), { rms: SPEECH, ms: 1000 }]);
    vad.setEndOfTurnMs(600);
    expect(play(vad, [{ rms: ROOM_TONE, ms: 800 }], 200_000)).toEqual(["speech-end"]);
  });

  test("an unreadable microphone never ends a turn on its own", () => {
    const vad = new VoiceActivityDetector();
    play(vad, [settle(), { rms: SPEECH, ms: 1000 }]);
    // A suspended AudioContext hands back nothing. Reading that as silence
    // would send half a sentence while the user is still talking.
    expect(play(vad, [{ rms: null, ms: 10_000 }], 300_000)).toEqual([]);
    expect(vad.isSpeaking).toBe(true);
  });

  test("a microphone held open forever still sends", () => {
    const vad = new VoiceActivityDetector();
    const events = play(vad, [settle(), { rms: SPEECH, ms: VAD_MAX_UTTERANCE_MS + 2000 }]);
    // Cut at the cap and picked straight back up, because whoever is talking
    // has not stopped: an hour of speech becomes turns, never one lost hour.
    expect(events).toEqual(["speech-start", "speech-end", "speech-start"]);
  });

  test("the turn starts at the first sound, not at the frame that confirmed it", () => {
    const vad = new VoiceActivityDetector();
    play(vad, [settle()]);
    // The recording sent for transcription is cut from this timestamp, so a
    // late one would clip the first word off every turn.
    const firstLoudAt = 1000 + 5000 + VAD_POLL_MS;
    play(vad, [{ rms: SPEECH, ms: 1000 }], 1000 + 5000);
    expect(vad.speechStartedAt).toBe(firstLoudAt);
  });

  test("a quiet microphone can still be heard once the room is known", () => {
    const vad = new VoiceActivityDetector();
    play(vad, [settle(0.0002, 8000)]);
    // Well under the absolute floor, far above this room's own noise.
    expect(vad.threshold).toBeLessThan(0.01);
    expect(play(vad, [{ rms: 0.006, ms: 1000 }], 50_000)).toEqual(["speech-start"]);
  });

  test("a noisy room raises the bar instead of talking to itself", () => {
    const vad = new VoiceActivityDetector();
    // A fan at a level that would be speech in a silent room.
    const events = play(vad, [{ rms: 0.006, ms: 30_000 }]);
    expect(events).toEqual([]);
    expect(vad.threshold).toBeGreaterThan(0.006);
  });

  test("reset ends the turn without forgetting the room", () => {
    const vad = new VoiceActivityDetector();
    play(vad, [settle(), { rms: SPEECH, ms: 1000 }]);
    const learned = vad.threshold;
    vad.reset();
    expect(vad.isSpeaking).toBe(false);
    expect(vad.threshold).toBe(learned);
  });
});
