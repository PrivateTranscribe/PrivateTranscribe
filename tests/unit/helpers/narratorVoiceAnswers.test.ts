import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  VoiceAnswers,
  WINDOW_MS,
  CONFIRM_MS,
  MAX_RECORDING_MS,
  GRACE_MS,
} = require("../../../src/helpers/narrator/voiceAnswers");

type Outcome = { result: string; label?: string };

function setup({
  alive = () => true,
  closeBy = Infinity,
  deadline = Infinity,
  onChange = () => {},
  log = () => {},
}: {
  alive?: () => boolean;
  closeBy?: number;
  deadline?: number;
  onChange?: () => void;
  log?: (message: string, data?: object) => void;
} = {}) {
  const recorder = { start: vi.fn(), stop: vi.fn(), discard: vi.fn() };
  const said: string[] = [];
  /** How each line's playback ends; "done" unless a test says otherwise. */
  let playback = "done";
  const say = vi.fn(async (text: string) => {
    said.push(text);
    return playback;
  });
  const stopSpeech = vi.fn();
  const answers = new VoiceAnswers({ recorder, onChange, log });
  const handle = answers.ask({
    chatName: "Export fix",
    options: ["Merge it", "Not now"],
    language: "en",
    say,
    stopSpeech,
    isAlive: alive,
    closeBy,
    deadline,
  });
  let outcome: Outcome | null = null;
  handle.outcome.then((value: Outcome) => {
    outcome = value;
  });
  const recordingId = () => recorder.start.mock.calls.at(-1)?.[0];
  return {
    answers,
    handle,
    recorder,
    said,
    stopSpeech,
    recordingId,
    outcome: () => outcome,
    playbackEnds: (result: string) => {
      playback = result;
    },
    /** A hold of the dictation key: down, then up. */
    hold: (token = 1) => answers.onKey({ type: "start", holdToken: token }),
    release: () => answers.onKey({ type: "stop" }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the voice answer window", () => {
  it("records a held key, reads the fitting label back, and picks it 3 s later", async () => {
    const t = setup();
    t.handle.questionDone();
    expect(t.hold()).toBe(true);
    expect(t.recorder.start).toHaveBeenCalledTimes(1);
    expect(t.release()).toBe(true);
    expect(t.recorder.stop).toHaveBeenCalledWith(t.recordingId());

    t.answers.heard(t.recordingId(), { text: "Uh, merge it." });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.said).toEqual(["Export fix: Merge it."]);
    await vi.advanceTimersByTimeAsync(CONFIRM_MS - 1);
    expect(t.outcome()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.outcome()).toEqual({ result: "picked", label: "Merge it", missed: 0 });
    // Closed: a press just after still belongs to the question, then the key dictates again.
    expect(t.answers.onKey({ type: "toggle" })).toBe(true);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(t.answers.onKey({ type: "toggle" })).toBe(false);
  });

  it("logs where a question ended, so a cancel shows which press caused it, without its words", async () => {
    const log = vi.fn();
    const t = setup({ log });
    t.handle.questionDone();
    t.hold();
    t.release();
    // Pressed again while the answer is still being transcribed.
    t.hold(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toHaveBeenCalledWith("Narrator voice question ended", {
      result: "cancelled",
      reason: undefined,
      phase: "hearing",
      missed: 0,
    });
  });

  it("cancels on a second press while the pick waits, says so, and keeps the release from dictation", async () => {
    const t = setup();
    t.handle.questionDone();
    t.hold();
    t.release();
    t.answers.heard(t.recordingId(), { text: "not now" });
    await vi.advanceTimersByTimeAsync(CONFIRM_MS - 500);
    expect(t.hold(2)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.outcome()).toEqual({ result: "cancelled", missed: 0 });
    expect(t.said).toEqual(["Export fix: Not now.", "Cancelled."]);
    expect(t.release()).toBe(true);
    // Only that one release; once the grace is over, the next press dictates.
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(t.answers.onKey({ type: "start", holdToken: 3 })).toBe(false);
  });

  it("says it did not catch an answer no label fits, then listens again until the window ends", async () => {
    const t = setup();
    t.handle.questionDone();
    t.hold();
    t.release();
    t.answers.heard(t.recordingId(), { text: "thank you" });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.said).toEqual(["I didn't catch that."]);
    expect(t.outcome()).toBeNull();
    // The second try is recorded like the first.
    expect(t.hold(2)).toBe(true);
    expect(t.recorder.start).toHaveBeenCalledTimes(2);
    t.release();
    t.answers.heard(t.recordingId(), { text: "still nothing" });
    await vi.advanceTimersByTimeAsync(WINDOW_MS - 1);
    expect(t.outcome()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    // Two tries were heard and fit no option: the caller can say "no match".
    expect(t.outcome()).toEqual({ result: "expired", missed: 2 });
  });

  it("ends 15 s after the question without a press; a late press never dictates, a later one does", async () => {
    const t = setup();
    t.handle.questionDone();
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(t.outcome()).toEqual({ result: "expired", missed: 0 });
    // Meant as an answer: as a dictation it would paste it into the game.
    expect(t.hold()).toBe(true);
    expect(t.release()).toBe(true);
    expect(t.recorder.start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(t.hold()).toBe(false);
    expect(t.release()).toBe(false);
  });

  it("does not dictate a press made as the question is dropped", async () => {
    let alive = true;
    const t = setup({ alive: () => alive });
    t.handle.questionDone();
    alive = false;
    expect(t.hold()).toBe(true);
    expect(t.recorder.start).not.toHaveBeenCalled();
    expect(t.release()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.outcome()).toEqual({ result: "stopped", missed: 0 });
  });

  it("never reads back a pick whose countdown would outlast the deadline: too late, nothing sent", async () => {
    const t = setup({ deadline: Date.now() + 5000 });
    t.handle.questionDone();
    t.hold();
    t.release();
    t.answers.heard(t.recordingId(), { text: "merge it" });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.said).toEqual(["Too late. It waits in the chat."]);
    expect(t.outcome()).toEqual({ result: "expired", reason: "too-late", missed: 0 });
  });

  it("says it is too late, rather than opening a window too short to answer in", async () => {
    const t = setup({ closeBy: Date.now() + 2000 });
    t.handle.questionDone();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.said).toEqual(["Too late. It waits in the chat."]);
    expect(t.outcome()).toEqual({ result: "expired", missed: 0 });
  });

  it("stops a line still being said when the deadline ends the session", async () => {
    const t = setup({ deadline: Date.now() + 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.outcome()).toEqual({ result: "expired", missed: 0 });
    expect(t.stopSpeech).toHaveBeenCalledTimes(1);
  });

  it("leaves the key to dictation with no question open", () => {
    const answers = new VoiceAnswers({
      recorder: { start: vi.fn(), stop: vi.fn(), discard: vi.fn() },
    });
    for (const type of ["toggle", "start", "stop", "cancel", "hybrid-down", "hybrid-up"]) {
      expect(answers.onKey({ type })).toBe(false);
    }
  });

  describe("between a question's chime and its first word", () => {
    const announced = (alive = () => true, until = Infinity) => {
      const recorder = { start: vi.fn(), stop: vi.fn(), discard: vi.fn() };
      const answers = new VoiceAnswers({ recorder });
      const end = answers.announce({ isAlive: alive, until });
      return { answers, recorder, end };
    };

    it("takes a tap and a hold, and records neither", () => {
      const t = announced();
      expect(t.answers.onKey({ type: "toggle" })).toBe(true);
      expect(t.answers.onKey({ type: "start", holdToken: 1 })).toBe(true);
      expect(t.answers.onKey({ type: "stop" })).toBe(true);
      expect(t.recorder.start).not.toHaveBeenCalled();
    });

    it("lets a dictation that began before the chime end as a dictation", () => {
      const t = announced();
      expect(t.answers.onKey({ type: "stop" })).toBe(false);
    });

    it("takes the release of a hold that is let go once the question is being said", () => {
      const t = announced();
      expect(t.answers.onKey({ type: "start", holdToken: 1 })).toBe(true);
      t.answers.ask({
        chatName: "Export fix",
        options: ["Merge it", "Not now"],
        language: "en",
        say: async () => "done",
        stopSpeech: () => {},
      });
      expect(t.answers.onKey({ type: "stop" })).toBe(true);
      expect(t.recorder.start).not.toHaveBeenCalled();
      // The next release is not the taken hold's: it ends a dictation.
      expect(t.answers.onKey({ type: "stop" })).toBe(false);
    });

    it("still takes a press for 3 s after the question was dropped unsaid, then dictates", async () => {
      const t = announced();
      t.end();
      expect(t.answers.onKey({ type: "toggle" })).toBe(true);
      await vi.advanceTimersByTimeAsync(GRACE_MS);
      expect(t.answers.onKey({ type: "toggle" })).toBe(false);
    });

    it("gives the key back at once when the question was stopped, not dropped", () => {
      const t = announced();
      t.end({ grace: false });
      expect(t.answers.onKey({ type: "toggle" })).toBe(false);
    });

    it("never holds the key past the question's own limits", async () => {
      let alive = true;
      const gone = announced(() => alive);
      alive = false;
      expect(gone.answers.onKey({ type: "toggle" })).toBe(false);

      const late = announced(() => true, Date.now() + 1000);
      await vi.advanceTimersByTimeAsync(1001);
      expect(late.answers.onKey({ type: "toggle" })).toBe(false);
    });
  });

  it("answers while the question is still being said, and stops saying it", () => {
    const t = setup();
    expect(t.hold()).toBe(true);
    expect(t.stopSpeech).toHaveBeenCalledTimes(1);
    expect(t.recorder.start).toHaveBeenCalledTimes(1);
    // The question's playback ends cut off; the recording carries on.
    t.handle.questionDone(false);
    expect(t.release()).toBe(true);
    expect(t.recorder.stop).toHaveBeenCalledTimes(1);
  });

  it("lets a dictation that began before the question end as a dictation", () => {
    const t = setup();
    expect(t.release()).toBe(false);
    expect(t.recorder.start).not.toHaveBeenCalled();
  });

  it("starts with a tap and stops with the next tap", () => {
    const t = setup();
    t.handle.questionDone();
    expect(t.answers.onKey({ type: "toggle" })).toBe(true);
    expect(t.recorder.stop).not.toHaveBeenCalled();
    expect(t.answers.onKey({ type: "toggle" })).toBe(true);
    expect(t.recorder.stop).toHaveBeenCalledTimes(1);
  });

  // "Tap or hold" is the default key mode. On Windows the key's presses are
  // sorted into taps and holds before they reach the answer window: a tap
  // arrives as one "toggle" when the key comes up, a hold as "start" and
  // "stop". So a tap's key-up does not end the answer it began.
  it("takes a tap in the default key mode as a tap: recording runs on after the key is up", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ActivationGestureController = require("../../../src/helpers/activationGestureController");
    const t = setup();
    t.handle.questionDone();
    const key = new ActivationGestureController({
      mode: "tapHold",
      onTap: () => t.answers.onKey({ type: "toggle" }),
      onHoldStart: () => t.answers.onKey({ type: "start", holdToken: 1 }),
      onHoldEnd: () => t.answers.onKey({ type: "stop" }),
    });

    key.keyDown();
    await vi.advanceTimersByTimeAsync(60);
    key.keyUp();
    expect(t.recorder.start).toHaveBeenCalledTimes(1);
    expect(t.recorder.stop).not.toHaveBeenCalled();

    // The next tap ends it, as it ends a dictation.
    key.keyDown();
    await vi.advanceTimersByTimeAsync(60);
    key.keyUp();
    expect(t.recorder.stop).toHaveBeenCalledTimes(1);
  });

  it("throws away a hold that was part of another shortcut and keeps listening", async () => {
    const t = setup();
    t.handle.questionDone();
    t.hold(7);
    expect(t.answers.onKey({ type: "cancel", holdToken: 7 })).toBe(true);
    expect(t.recorder.discard).toHaveBeenCalledWith(t.recordingId());
    expect(t.hold(8)).toBe(true);
    expect(t.recorder.start).toHaveBeenCalledTimes(2);
  });

  it("stops recording by itself when the key is held too long", async () => {
    const t = setup();
    t.handle.questionDone();
    t.hold();
    await vi.advanceTimersByTimeAsync(MAX_RECORDING_MS);
    expect(t.recorder.stop).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when the read-back was cut off before it ended", async () => {
    const t = setup();
    t.handle.questionDone();
    t.hold();
    t.release();
    t.playbackEnds("stopped");
    t.answers.heard(t.recordingId(), { text: "merge it" });
    await vi.advanceTimersByTimeAsync(CONFIRM_MS);
    expect(t.outcome()).toMatchObject({ result: "cancelled" });
  });

  it("closes, and drops a recording, once the question is no longer wanted", async () => {
    let alive = true;
    const t = setup({ alive: () => alive });
    t.handle.questionDone();
    t.hold();
    alive = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(t.outcome()).toEqual({ result: "stopped", missed: 0 });
    expect(t.recorder.discard).toHaveBeenCalledWith(t.recordingId());
  });

  it("records in the question's language, for a transcription set to Auto", () => {
    const t = setup();
    t.handle.questionDone();
    t.hold();
    expect(t.recorder.start).toHaveBeenCalledWith(t.recordingId(), { language: "en" });
  });

  it("closes the window early when the caller's time runs out first", async () => {
    const t = setup({ closeBy: Date.now() + 5000 });
    t.handle.questionDone();
    await vi.advanceTimersByTimeAsync(4999);
    expect(t.outcome()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.outcome()).toEqual({ result: "expired", missed: 0 });
  });

  it("ends at the deadline whatever it is doing, and drops the recording", async () => {
    const t = setup({ deadline: Date.now() + 8000 });
    t.handle.questionDone();
    await vi.advanceTimersByTimeAsync(7000);
    t.hold();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.outcome()).toEqual({ result: "expired", missed: 0 });
    expect(t.recorder.discard).toHaveBeenCalledWith(t.recordingId());
  });

  it("shows each step: the window's end, the pick and the time left to cancel", async () => {
    const changes = vi.fn();
    const t = setup({ onChange: changes });
    expect(t.answers.snapshot()).toMatchObject({ phase: "asking", missed: 0 });
    t.handle.questionDone();
    expect(t.answers.snapshot()).toMatchObject({
      phase: "open",
      windowEndsAt: Date.now() + WINDOW_MS,
    });
    t.hold();
    expect(t.answers.snapshot()).toMatchObject({ phase: "recording", windowEndsAt: null });
    t.release();
    expect(t.answers.snapshot()?.phase).toBe("hearing");
    t.answers.heard(t.recordingId(), { text: "merge it" });
    expect(t.answers.snapshot()).toMatchObject({ phase: "reading", picked: "Merge it" });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.answers.snapshot()).toMatchObject({
      phase: "confirming",
      picked: "Merge it",
      confirmEndsAt: Date.now() + CONFIRM_MS,
    });
    await vi.advanceTimersByTimeAsync(CONFIRM_MS);
    expect(t.answers.snapshot()).toBeNull();
    expect(changes.mock.calls.length).toBeGreaterThanOrEqual(7);
  });

  it("opens no window for a question that was not heard to the end", async () => {
    const t = setup();
    t.handle.questionDone(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.outcome()).toEqual({ result: "not-heard", missed: 0 });
    expect(t.recorder.start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(t.hold()).toBe(false);
  });
});
