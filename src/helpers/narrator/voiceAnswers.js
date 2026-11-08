"use strict";

/**
 * The answer window: while the narrator asks a question and for 15 s after,
 * the dictation key answers it instead of dictating.
 *
 *   asking ── question ends ──▶ open ── 15 s, no press ──▶ expired
 *     │                          │
 *     └──── press ───────────────┴─▶ recording ── release ──▶ hearing
 *                                                                │
 *        no label fits: "didn't catch that", then open again ◀───┤
 *                                                                ▼
 *        reading "<chat>: <label>." ── ends ──▶ confirming ── 3 s ──▶ picked
 *                  └──────── a press while hearing, reading or confirming ──▶ cancelled
 *
 * Nothing here pastes or types. The recording is the overlay's own, its text
 * is matched to the question's own labels and then dropped, and only a label
 * leaves, to the caller that asked. Outside a session every key event goes
 * on to dictation untouched, except a press in the first 3 s after one ends:
 * that press was meant as an answer, and as a dictation it would paste it
 * into the game or the call.
 *
 * A caller with a time limit gives `closeBy`, after which no new answer is
 * taken, and `deadline`, at which the session ends whatever it is doing. A
 * pick is read back only when its 3 s countdown can still finish before the
 * deadline; otherwise it is "too late" and nothing is sent, so a pick that is
 * read back is a pick that goes. The outcome counts the tries that matched no
 * label (`missed`), so an expired window can tell "nothing said" from "said,
 * but not one of the options".
 *
 * Key events come from the window manager, one per thing the dictation key
 * would have done: "toggle" (a tap), "start" and "stop" (a hold), "cancel" (a
 * hold that was part of another shortcut), "hybrid-down" and "hybrid-up".
 */

const crypto = require("node:crypto");
const { matchAnswer } = require("./answerMatch");

/** How long the dictation key answers after the question ends. */
const WINDOW_MS = 15_000;
/** How long a read-back waits before the pick goes; a press meanwhile cancels it. */
const CONFIRM_MS = 3_000;
/** The longest answer recorded; holding the key longer stops it anyway. Twelve words fit. */
const MAX_RECORDING_MS = 6_000;
/** The longest a recording may take to transcribe; the first can load the model. */
const HEARING_TIMEOUT_MS = 30_000;
/** How often a session checks that its question is still wanted. */
const ALIVE_POLL_MS = 250;
/** After a session ends, a press still belongs to it for this long and never dictates. */
const GRACE_MS = 3_000;
/** The shortest answer window worth opening: a press, a word or two, and letting go. */
const MIN_WINDOW_MS = 3_000;

/** A generous guess at how long a line takes to say, to leave time for what follows it. */
function speakingMs(line) {
  return 800 + 70 * String(line || "").length;
}

const PRESSES = new Set(["toggle", "start", "hybrid-down"]);
const RELEASES = new Set(["stop", "hybrid-up", "cancel"]);

/**
 * "A, B, or C", for saying a question's choices. The comma before "or" is a
 * pause in speech: labels of several words would otherwise run together.
 */
function listOf(choices, or) {
  if (choices.length <= 1) return choices[0] || "";
  return `${choices.slice(0, -1).join(", ")}, ${or} ${choices.at(-1)}`;
}

const PHRASES = {
  da: {
    question: (chat, question, choices) =>
      `${chat} spørger: ${question} Sig ${listOf(choices, "eller")}.`,
    notCaught: "Det fangede jeg ikke.",
    cancelled: "Annulleret.",
    tooLate: "For sent. Den venter i chatten.",
    readBack: (chat, label) => `${chat}: ${label}.`,
  },
  en: {
    question: (chat, question, choices) =>
      `${chat} asks: ${question} Say ${listOf(choices, "or")}.`,
    notCaught: "I didn't catch that.",
    cancelled: "Cancelled.",
    tooLate: "Too late. It waits in the chat.",
    readBack: (chat, label) => `${chat}: ${label}.`,
  },
};

const DANISH_WORDS = new Set(
  "og ikke det er skal jeg du vil nu med til på af kan hvad hvordan hvor eller den de vi har må lige bare også så nej ja godt noget efter før mig dig være skulle".split(
    " "
  )
);
const ENGLISH_WORDS = new Set(
  "the and is to it you now with should can what how where or not this that we have may just also so no yes good something after before me want would which shall be".split(
    " "
  )
);

/** How far one language's words must lead before they overrule the narrator's own language. */
const LANGUAGE_LEAD = 2;

/**
 * The language to say a chat's question in: the narrator's own language,
 * unless the question's words are clearly the other one, so the voice can
 * pronounce it. A word with æ, ø or å counts as one Danish word, so a Danish
 * name in an English question does not flip it.
 *
 * @param {string} text   the question and its choices
 * @param {"da"|"en"} [fallback]   the "Speak in" setting
 */
function questionLanguage(text, fallback = "en") {
  const value = String(text || "").toLowerCase();
  let danish = 0;
  let english = 0;
  for (const word of value.split(/[^\p{L}]+/u)) {
    if (DANISH_WORDS.has(word) || /[æøå]/.test(word)) danish += 1;
    if (ENGLISH_WORDS.has(word)) english += 1;
  }
  if (danish - english >= LANGUAGE_LEAD) return "da";
  if (english - danish >= LANGUAGE_LEAD) return "en";
  return fallback === "da" ? "da" : "en";
}

class VoiceAnswers {
  /**
   * @param {object} deps
   * @param {{start: Function, stop: Function, discard: Function}} deps.recorder
   *   the overlay's answer recorder, by recording id; its text comes back on heard()
   * @param {Function} [deps.log]
   */
  constructor({ recorder, log = () => {}, onChange = () => {} }) {
    this.recorder = recorder;
    this.debug = log;
    /** Called whenever the session's phase or what it shows changes. */
    this.onChange = onChange;
    this.session = null;
    /** A hold began a press the session took; its release must not reach dictation. */
    this.holding = false;
    this.swallowRelease = false;
    /** Until when a press still belongs to the session that just ended. */
    this.graceUntil = 0;
  }

  /** Whether the dictation key answers a question right now. */
  get active() {
    return Boolean(this.session);
  }

  /** What the overlay shows of the open session, or null. */
  snapshot() {
    const session = this.session;
    if (!session) return null;
    return {
      phase: session.phase,
      windowEndsAt: session.phase === "open" ? session.windowEndsAt : null,
      picked: session.picked,
      confirmEndsAt: session.phase === "confirming" ? session.confirmEndsAt : null,
      missed: session.missed,
      /** How it ended, while its last line is said. */
      ended: session.ended,
    };
  }

  /** Ends the open session, if any, without a pick. */
  close(result = "stopped") {
    if (this.session) void this._finish(this.session, { result });
  }

  /**
   * Opens a session for one question, while it is being asked.
   *
   * @param {object} question
   * @param {string} question.chatName   said in the read-back
   * @param {string[]} question.options  the only answers that can come back
   * @param {"da"|"en"} question.language
   * @param {(text: string) => Promise<string|null>} question.say
   *   speaks a line in the question's job; resolves with how its playback ended
   * @param {() => void} question.stopSpeech   cuts what the job is saying now
   * @param {() => boolean} [question.isAlive]   false once the question is no longer wanted
   * @param {number} [question.closeBy]    epoch ms after which no new answer is taken
   * @param {number} [question.deadline]   epoch ms at which the session ends, whatever it does
   * @returns {{questionDone: () => void, close: (result?: string) => void, outcome: Promise<object>}}
   */
  ask({
    chatName,
    options,
    language,
    say,
    stopSpeech,
    isAlive = () => true,
    closeBy = Infinity,
    deadline = Infinity,
  }) {
    if (this.session) this._finish(this.session, { result: "replaced" });
    const session = {
      chatName,
      options,
      language: PHRASES[language] ? language : "en",
      phrases: PHRASES[language] || PHRASES.en,
      say,
      stopSpeech,
      isAlive,
      closeBy,
      deadline,
      phase: "asking",
      recording: null,
      timer: null,
      windowEndsAt: null,
      picked: null,
      confirmEndsAt: null,
      missed: 0,
      ended: null,
      done: false,
    };
    session.outcome = new Promise((resolve) => {
      session.resolve = resolve;
    });
    session.alive = setInterval(() => {
      if (!session.isAlive()) this._finish(session, { result: "stopped" });
    }, ALIVE_POLL_MS);
    if (Number.isFinite(deadline)) {
      session.hardStop = setTimeout(
        () => this._finish(session, { result: "expired" }),
        Math.max(0, deadline - Date.now())
      );
    }
    this.session = session;
    this._changed();
    return {
      outcome: session.outcome,
      questionDone: (heard = true) => this._questionDone(session, heard),
      close: (result = "stopped") => this._finish(session, { result }),
    };
  }

  /**
   * One dictation key event. True when it answered the question, so dictation
   * must not see it; false sends it on to dictation unchanged.
   */
  onKey(event) {
    const type = event?.type;
    if (!PRESSES.has(type) && !RELEASES.has(type)) return false;
    const isHold = type === "start" || type === "hybrid-down";
    const session = this.session;

    if (!session) {
      if (RELEASES.has(type)) {
        // The release of a press that ended a session, or came just after it, belongs to it.
        const swallow = this.swallowRelease;
        this.swallowRelease = false;
        return swallow;
      }
      // A press just after a question ended was meant for it: as a dictation it
      // would paste the answer into the game or the call.
      if (Date.now() < this.graceUntil) {
        if (isHold) this.swallowRelease = true;
        return true;
      }
      this.swallowRelease = false;
      return false;
    }
    if (!session.isAlive()) {
      this._finish(session, { result: "stopped" });
      // Pressed while the question still showed: meant as an answer, so not a dictation.
      if (!PRESSES.has(type)) return false;
      if (isHold) this.swallowRelease = true;
      return true;
    }
    if (RELEASES.has(type)) this.holding = false;
    else if (isHold) this.holding = true;

    switch (session.phase) {
      case "asking":
      case "open":
        // A release here ends a dictation that began before the question.
        if (!PRESSES.has(type)) return false;
        this._record(session, event);
        return true;
      case "recording": {
        const { recording } = session;
        if (type === "cancel") {
          if (event.holdToken === undefined || event.holdToken === recording.holdToken) {
            this._discard(session);
          }
        } else if (RELEASES.has(type) ? recording.via === "hold" : recording.via === "toggle") {
          this._stopRecording(session);
        }
        return true;
      }
      case "hearing":
      case "reading":
      case "confirming":
        if (PRESSES.has(type)) this._cancel(session);
        return true;
      default:
        // Closing: a short last line is being said.
        return true;
    }
  }

  /** The overlay's text for a recording, or the error it hit. */
  heard(recordingId, { text = "", error = null } = {}) {
    const session = this.session;
    if (!session || session.phase !== "hearing" || session.recording?.id !== recordingId) return;
    clearTimeout(session.timer);
    const match = error ? null : matchAnswer(text, session.options);
    this.debug("Narrator heard a voice answer", {
      matched: Boolean(match),
      score: match ? Number(match.score.toFixed(2)) : null,
      error: error || undefined,
    });
    if (match) void this._readBack(session, match.label);
    else void this._notCaught(session);
  }

  // ------------------------------------------------------------- the flow

  _questionDone(session, heard) {
    if (this.session !== session || session.phase !== "asking") return;
    // An answer needs a question that was heard to the end.
    if (heard) this._open(session);
    else this._finish(session, { result: "not-heard" });
  }

  _open(session) {
    clearTimeout(session.timer);
    const left = Math.min(WINDOW_MS, session.closeBy - Date.now());
    // Said so late that no answer fits any more: it says so, rather than going quiet.
    if (!(left >= MIN_WINDOW_MS)) {
      void this._finish(session, { result: "expired" }, session.phrases.tooLate);
      return;
    }
    session.phase = "open";
    session.recording = null;
    session.windowEndsAt = Date.now() + left;
    session.timer = setTimeout(() => this._finish(session, { result: "expired" }), left);
    this._changed();
  }

  _record(session, event) {
    if (session.phase === "asking") session.stopSpeech();
    clearTimeout(session.timer);
    session.recording = {
      id: crypto.randomUUID(),
      via: event.type === "toggle" ? "toggle" : "hold",
      holdToken: event.holdToken,
    };
    session.phase = "recording";
    this.recorder.start(session.recording.id, { language: session.language });
    session.timer = setTimeout(() => this._stopRecording(session), MAX_RECORDING_MS);
    this._changed();
  }

  _stopRecording(session) {
    if (this.session !== session || session.phase !== "recording") return;
    clearTimeout(session.timer);
    session.phase = "hearing";
    const { id } = session.recording;
    this.recorder.stop(id);
    session.timer = setTimeout(() => this.heard(id, { error: "timeout" }), HEARING_TIMEOUT_MS);
    this._changed();
  }

  /** The hold was part of another shortcut: its recording goes, the window stays. */
  _discard(session) {
    this.recorder.discard(session.recording.id);
    this._open(session);
  }

  async _notCaught(session) {
    // Said like the question: a press while it plays records the next try.
    session.missed += 1;
    session.phase = "asking";
    session.recording = null;
    this._changed();
    // A voice that fails ends the question now, not at the 39 s deadline.
    const result = await session.say(session.phrases.notCaught).catch(() => "failed");
    if (this.session === session && session.phase === "asking") {
      this._questionDone(session, result === "done" || result === "stopped");
    }
  }

  async _readBack(session, label) {
    const line = session.phrases.readBack(session.chatName, label);
    // Read back only a pick that can still go: its countdown must end in time.
    if (Date.now() + speakingMs(line) + CONFIRM_MS > session.deadline) {
      void this._finish(
        session,
        { result: "expired", reason: "too-late" },
        session.phrases.tooLate
      );
      return;
    }
    session.phase = "reading";
    session.picked = label;
    this._changed();
    const result = await session.say(line).catch(() => "failed");
    if (this.session !== session || session.phase !== "reading") return;
    // A pick goes only after it was heard in full.
    if (result !== "done") {
      this._finish(session, { result: "cancelled", reason: "read-back-not-heard" });
      return;
    }
    session.phase = "confirming";
    session.confirmEndsAt = Date.now() + CONFIRM_MS;
    session.timer = setTimeout(
      () => this._finish(session, { result: "picked", label }),
      CONFIRM_MS
    );
    this._changed();
  }

  _cancel(session) {
    if (session.phase === "reading") session.stopSpeech();
    void this._finish(session, { result: "cancelled" }, session.phrases.cancelled);
  }

  async _finish(session, outcome, lastLine = null) {
    if (session.done) return;
    session.done = true;
    clearTimeout(session.timer);
    clearTimeout(session.hardStop);
    clearInterval(session.alive);
    if (session.phase === "recording") this.recorder.discard(session.recording.id);
    // A line still being said ends with the session, so nothing outlives the outcome.
    if (session.phase === "asking" || session.phase === "reading") session.stopSpeech?.();
    session.phase = "closing";
    session.ended = outcome.result;
    this._changed();
    if (lastLine) {
      try {
        await session.say(lastLine);
      } catch {
        // The outcome stands whether or not its last line could be said.
      }
    }
    if (this.session === session) this.session = null;
    if (this.holding) this.swallowRelease = true;
    this.holding = false;
    this.graceUntil = Date.now() + GRACE_MS;
    session.resolve({ ...outcome, missed: session.missed });
    this._changed();
  }

  _changed() {
    try {
      this.onChange();
    } catch {
      // A listener's failure is not the session's.
    }
  }
}

module.exports = {
  VoiceAnswers,
  PHRASES,
  questionLanguage,
  WINDOW_MS,
  CONFIRM_MS,
  MAX_RECORDING_MS,
  HEARING_TIMEOUT_MS,
  GRACE_MS,
};
