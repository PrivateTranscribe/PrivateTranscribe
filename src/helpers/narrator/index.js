"use strict";

/**
 * The agent narrator: tells the user out loud what their Claude Code chats
 * need from them, and keeps everything else as cards.
 *
 *   source ──events──▶ router ──▶ rewriter ──▶ voice ──▶ overlay plays it
 *                          └──────▶ cards (the Narrator page)
 *
 * Five parts, each behind a narrow interface, so the whole folder can leave
 * PrivateTranscribe one day:
 *   source    start(), stop(), emits {kind, chatId, chatTitle, recap, ask, at}
 *   router    pure state: what interrupts, what is a card, what was heard
 *   rewriter  rewrite(item, language), rewriteMany(items, language)
 *   voices    synthesize(text) -> {pcm, sampleRate}, one per language
 *   playback  openPlayback({chime}) -> push(part), end(), cancel(), result
 *
 * A wait's rewrite starts at its wrap_up call, while the chat still writes its
 * closing words. It chimes the moment its turn ends, or when its turn comes
 * if something else is being said, and is spoken once its rewrite is back.
 * The chime is a playback of its own, so an item counts as heard only once
 * its words play. Each sentence plays as soon as it is made. Stop, switching off, and an answer in the chat all cut off
 * the item they concern, including one still being rewritten or made.
 *
 * Making room: after the chime, an unasked line waits for a pause in a voice
 * call (at most 8 s), and while the narrator speaks, other apps play at 30%.
 * Gaming mode speaks only what waits on the user and never listens.
 *
 * Narrator mode: with "only chats in narrator mode" on (the default), a chat
 * is heard only while it has narrator mode on (narratorMode.js); every other
 * chat is silent and has no card.
 *
 * Voice questions: in gaming mode with "Answer by voice" on, a chat can call
 * the ask_by_voice tool (askServer.js). Its question is said with its
 * choices, the dictation key answers it (voiceAnswers.js), and the pick goes
 * back to the chat as the tool's result: only ever one of the chat's own
 * choices, never a consent. Everything else a chat asks stays in the chat.
 */

const fs = require("node:fs");
const path = require("node:path");
const { NarratorRouter } = require("./router");
const { NarratorRewriter } = require("./rewriter");
const { ClaudeTranscriptSource } = require("./claudeTranscriptSource");
const { matchCommand } = require("./commands");
const { toSpeakable, splitSentences, redact } = require("./spokenText");
const { NarratorLog } = require("./narratorLog");
const { VoiceAnswers, questionLanguage, PHRASES: ANSWER_PHRASES } = require("./voiceAnswers");
const { NarratorModes } = require("./narratorMode");

const DEFAULT_SETTINGS = {
  enabled: false,
  /** Language for interruptions; a question is answered in the language it was asked in. */
  language: "da",
  /** Danish voice: "piper-da" (default) or "roest-da" (opt-in). */
  voiceDa: "piper-da",
  /** Kokoro voice id for English; the overlay keeps it equal to the Read Aloud voice. */
  voiceEn: "bm_lewis",
  /** Listen for "hvad er nyt?" without a key; the overlay owns the microphone. */
  listen: false,
  /**
   * Stop speaking when the microphone hears the user. Off by default: through
   * speakers the microphone hears the narrator itself, and no voice tool we
   * looked at interrupts on sound for that reason. Meant for a headset.
   */
  bargeIn: false,
  /**
   * Gaming mode: only chats that wait on the user are spoken, and nothing
   * listens to the room, so talk on a voice call is never taken for a command.
   */
  gaming: false,
  /**
   * Before a line nobody asked for, wait for a pause in a voice call (Discord,
   * Teams, Zoom, Slack); while speaking, lower every other app.
   */
  makeRoom: true,
  /**
   * For 15 s after a spoken question, the dictation key answers it with one of
   * the question's own options instead of dictating. Needs local transcription.
   */
  answerByVoice: false,
  /**
   * Only chats with narrator mode on are heard; the rest are silent. A chat
   * turns it on by loading a skill named "narrator" or "<something>-narrator".
   */
  onlyNarratorMode: true,
  followed: [],
};

const PHRASES = {
  da: {
    nothing: "Der er ikke noget nyt.",
    count: (n) => (n === 1 ? "Der er én ny ting." : `Der er ${n} nye ting.`),
    rest: (n) => (n === 1 ? "Én mere ligger som kort." : `${n} mere ligger som kort.`),
    noCurrent: "Der er ikke noget at fortælle mere om endnu.",
    follow: (title) => `Jeg følger ${title || "den chat"} nu.`,
    noFollow: "Der er ingen chat at følge endnu.",
    test: "Hej. Sådan lyder fortælleren, når en chat venter på dig.",
  },
  en: {
    nothing: "Nothing new.",
    count: (n) => (n === 1 ? "There is one new thing." : `There are ${n} new things.`),
    rest: (n) => (n === 1 ? "One more is waiting as a card." : `${n} more are waiting as cards.`),
    noCurrent: "There is nothing to say more about yet.",
    follow: (title) => `Following ${title || "that chat"} now.`,
    noFollow: "There is no chat to follow yet.",
    test: "Hello. This is how the narrator sounds when a chat waits on you.",
  },
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Longest one sentence may take to make before the voice counts as hung. Røst
 * includes its first start, about 45 s on the processor.
 */
const SYNTH_TIMEOUT_MS = { "piper-da": 15_000, "kokoro-en": 30_000, "roest-da": 90_000 };
/** After Røst fails, Danish uses Piper for this long before Røst is tried again. */
const ROEST_RETRY_MS = 10 * 60 * 1000;

/**
 * ask_by_voice's time budget, from the call: the tool must answer within
 * about 40 s, and its bridge gives up at 40 s exactly.
 *
 *   0 s       call; chime; wait for a pause in a voice call (4 s at most)
 *   ~10 s     the question with its choices has been said; the window opens
 *   ≤ 27 s    the window closes: 15 s after the question, or at 27 s
 *   ≤ 39 s    recording (6 s at most), hearing, read-back, the 3 s to cancel
 */
const QUESTION_START_BY_MS = 8_000;
const QUESTION_CLOSE_BY_MS = 27_000;
const QUESTION_DEADLINE_MS = 39_000;
const QUESTION_PAUSE_MS = 4_000;
/** A question left unanswered counts as waiting until its chat is answered, or this long. */
const MISSED_TTL_MS = 2 * 60 * 60 * 1000;

const NOT_ACTIVE = Object.freeze({ answer: null, reason: "not_active" });

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(message), { code: "timeout" })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

class Narrator {
  /**
   * @param {object} deps
   * @param {string} [deps.dataDir]   where settings and the log live (userData)
   * @param {(opts: {chime: boolean}) => object} deps.openPlayback   one item's playback in the overlay
   * @param {() => void} [deps.stopPlayback]   silences the overlay whatever it plays
   * @param {Record<string, object>} deps.voices   by id: piper-da, roest-da, kokoro-en
   * @param {(onEvent: Function) => {start: Function, stop: Function}} [deps.createSource]
   * @param {object} [deps.rewriter]
   * @param {object} [deps.room]   watchCall() -> {waitForPause, close}; duck(); restore()
   * @param {object} [deps.answerRecorder]   the overlay's answer recorder: start(id, {language}), stop(id), discard(id)
   * @param {object} [deps.narratorModes]   which chats have narrator mode on (narratorMode.js)
   * @param {(url: string) => void} [deps.openUrl]
   * @param {(state: object) => void} [deps.onState]
   * @param {() => void} [deps.onDispose]   lets go of what was opened for the narrator
   */
  constructor({
    dataDir = null,
    openPlayback,
    stopPlayback = () => {},
    voices = {},
    createSource,
    rewriter,
    room = null,
    answerRecorder = null,
    narratorModes = null,
    openUrl = () => {},
    onState = () => {},
    onDispose = () => {},
    log = () => {},
    now = () => Date.now(),
  }) {
    this.dataDir = dataDir;
    this.openPlayback = openPlayback;
    this.stopPlayback = stopPlayback;
    this.voices = voices;
    this.narratorModes = narratorModes || new NarratorModes({ log });
    this.createSource =
      createSource ||
      ((onEvent) =>
        new ClaudeTranscriptSource({
          onEvent,
          log,
          // Asked only while it matters: the first answer for a chat reads its whole transcript.
          narratorMode: (file) =>
            this.settings.onlyNarratorMode ? this.narratorModes.modeOf(file) : null,
        }));
    this.rewriter = rewriter || new NarratorRewriter({ log });
    this.room = room;
    this.answerRecorder = answerRecorder;
    this.answers = new VoiceAnswers({
      recorder: answerRecorder || { start() {}, stop() {}, discard() {} },
      log,
      onChange: () => this._onAnswerChange(),
    });
    /** Whether the overlay transcribes locally with no cloud fallback; answers need it. */
    this.localOnly = false;
    /** The voice question being asked, or the last one, for the overlay and the page. */
    this.question = null;
    this.questionCount = 0;
    /** Chats whose voice question went unanswered, until they are answered at the PC. */
    this.missed = new Map();
    this.openUrlHandler = openUrl;
    this.onState = onState;
    this.onDispose = onDispose;
    this.debug = log;
    this.now = now;

    this.settings = this._loadSettings();
    this.router = new NarratorRouter({ now });
    for (const chatId of this.settings.followed) this.router.follow(chatId);
    this.log = new NarratorLog(dataDir ? path.join(dataDir, "narrator-log.jsonl") : null, { now });
    this.gate = false;
    this.source = null;
    this.queue = [];
    /** Bumped by stop(): every job started under an older generation is void. */
    this.generation = 0;
    this.current = null;
    this.draining = false;
    this.voiceError = null;
    /** Until when Danish skips Røst after it failed (epoch ms). */
    this.roestDownUntil = 0;
    /** How the last spoken item ended in the overlay, and how soon after its turn ended it began. */
    this.lastPlayback = null;
    this.rewrites = new Map();
    /** Rewrites started from a wrap_up before its turn ended, by what they rewrite. */
    this.prefetched = new Map();
  }

  // ------------------------------------------------------------- lifecycle

  get running() {
    return Boolean(this.source);
  }

  /** The Experimental switch, as the renderer reports it. Off stops everything. */
  setGate(experimentalOn) {
    this.gate = Boolean(experimentalOn);
    this._apply();
  }

  /** Whether the overlay transcribes locally with no cloud fallback, as it reports it. */
  setLocalOnly(localOnly) {
    this.localOnly = Boolean(localOnly);
    this._dropQuestionsIfOff();
    this._emitState();
  }

  /** Whether a question asked now may open the answer window. */
  get canAnswer() {
    return Boolean(this.settings.answerByVoice && this.localOnly && this.answerRecorder);
  }

  /** Whether ask_by_voice is answered now: gaming mode, Answer by voice, and local transcription. */
  get takesVoiceQuestions() {
    return Boolean(this.running && this.settings.gaming && this.canAnswer);
  }

  updateSettings(patch = {}) {
    const next = { ...this.settings };
    if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
    if (patch.language === "da" || patch.language === "en") next.language = patch.language;
    if (patch.voiceDa === "piper-da" || patch.voiceDa === "roest-da") next.voiceDa = patch.voiceDa;
    if (typeof patch.voiceEn === "string" && /^[a-z]{2}_[a-z]+$/.test(patch.voiceEn)) {
      next.voiceEn = patch.voiceEn;
    }
    if (typeof patch.listen === "boolean") next.listen = patch.listen;
    if (typeof patch.bargeIn === "boolean") next.bargeIn = patch.bargeIn;
    if (typeof patch.gaming === "boolean") next.gaming = patch.gaming;
    if (typeof patch.makeRoom === "boolean") next.makeRoom = patch.makeRoom;
    if (typeof patch.answerByVoice === "boolean") next.answerByVoice = patch.answerByVoice;
    if (typeof patch.onlyNarratorMode === "boolean") next.onlyNarratorMode = patch.onlyNarratorMode;
    const previous = this.settings;
    this.settings = next;
    this._saveSettings();
    if (next.onlyNarratorMode && !previous.onlyNarratorMode && this.running) {
      void this._pruneOutOfMode();
    }
    if (next.voiceDa !== previous.voiceDa) {
      // Røst holds gigabytes of model while it runs; a voice set aside lets go of it.
      this.voices[previous.voiceDa]?.unload?.();
      this.roestDownUntil = 0;
    }
    this._apply();
    this._dropQuestionsIfOff();
    if (this.running) this._voiceFor(next.language)?.warm?.();
    return this.getState();
  }

  _apply() {
    const shouldRun = this.settings.enabled && this.gate;
    if (shouldRun && !this.source) {
      this.source = this.createSource((event) => this.ingest(event));
      this.source.start();
      this.rewriter.warm?.();
      this._voiceFor(this.settings.language)?.warm?.();
    } else if (!shouldRun && this.source) {
      this.source.stop();
      this.source = null;
      this.stop();
      // Cards describe chats as they were while it ran; switched off, they would go stale.
      this.router.clear();
      this.rewrites.clear();
      this.prefetched.clear();
      this.missed.clear();
      this.question = null;
      this.narratorModes.clear();
      this.rewriter.close?.();
      for (const voice of Object.values(this.voices)) voice?.unload?.();
    }
    this._emitState();
  }

  dispose() {
    this.source?.stop();
    this.source = null;
    this.generation += 1;
    this._settleQueued();
    this.queue = [];
    this.answers.close();
    this.current?.playback?.cancel();
    this.rewriter.close?.();
    for (const voice of Object.values(this.voices)) voice?.unload?.();
    try {
      this.onDispose();
    } catch (error) {
      this.debug("Narrator could not close everything", { error: String(error?.message || error) });
    }
  }

  // ---------------------------------------------------------------- events

  ingest(event) {
    if (
      this.settings.onlyNarratorMode &&
      event?.kind !== "answered" &&
      event?.narratorMode !== true
    ) {
      // A chat out of narrator mode is silent and has no card; one that left it loses its card.
      const removed = typeof event?.chatId === "string" ? this.router.removeChat(event.chatId) : [];
      if (removed.length > 0) {
        this._dropItems(removed);
        this._emitState();
      }
      return { action: "ignore" };
    }
    if (event?.provisional) {
      this._prefetch(event);
      return { action: "ignore" };
    }
    if (event?.kind === "answered" && this.missed.delete(event.chatId)) this._emitState();
    const decision = this.router.ingest(event);
    // Every card that turned up while it ran counts; cards from startup do not.
    if (["interrupt", "speak", "card"].includes(decision.action) && !event.backlog) {
      this.log.append({
        kind: "card",
        chatId: decision.item.chatId,
        chatTitle: redact(decision.item.chatTitle, 200),
      });
    }
    // Gaming mode speaks only what waits on the user: a followed chat's news stays a card.
    const speakFollowed = decision.action === "speak" && !this.settings.gaming;
    if (decision.action === "interrupt" || speakFollowed) {
      // Rewritten at once, so an item queued behind other speech is ready when its turn comes.
      void this._rewrite(decision.item, this.settings.language);
    }
    if (decision.action === "interrupt") {
      const job = this._job({ kind: "interrupt", itemId: decision.item.id });
      // The chime goes out now, while the rewrite is made, unless something is
      // being said: then it sounds when the item's turn comes (_run).
      if (!this.current && this.queue.length === 0) job.chimePlayback = this._chime();
      this._enqueue(job);
    } else if (speakFollowed) {
      this._enqueue(this._job({ kind: "followed", itemId: decision.item.id, chime: false }));
    } else if (decision.action === "removed") {
      this._dropItems(decision.removed);
    }
    if (decision.action !== "ignore") this._emitState();
    return decision;
  }

  /** Items gone from the queue: their queued speech goes, and speech in flight about them stops. */
  _dropItems(ids) {
    const removed = new Set(ids);
    this.queue = this.queue.filter((job) => !removed.has(job.itemId));
    if (this.current && removed.has(this.current.itemId)) {
      this.current.cancelled = true;
      // Its chime too: the overlay holds one while a dictation runs, maybe the answer itself.
      this.current.chimePlayback?.cancel();
      this.current.playback?.cancel();
    }
  }

  // -------------------------------------------------------------- commands

  /** A transcribed utterance from the overlay's listener. */
  handleUtterance(text) {
    const match = matchCommand(text);
    if (!match) return null;
    this.command(match.command, match.language);
    return match;
  }

  command(name, language) {
    const lang = language === "en" || language === "da" ? language : this.settings.language;
    if (!this.running) return false;
    if (name === "stop") this.stop();
    else if (name === "brief") this._enqueue(this._job({ kind: "brief", language: lang }));
    else if (name === "more") this._enqueue(this._job({ kind: "more", language: lang }));
    else if (name === "follow") this.followCurrent(lang);
    else return false;
    return true;
  }

  followCurrent(language) {
    const item = this.router.current();
    const lang = language || this.settings.language;
    if (!item) {
      this._say(PHRASES[lang].noFollow, lang);
      return null;
    }
    this.follow(item.chatId);
    this._say(PHRASES[lang].follow(toSpeakable(item.chatTitle)), lang);
    return item.chatId;
  }

  follow(chatId) {
    if (!this.router.follow(chatId)) return;
    this.settings.followed = Array.from(new Set([...this.settings.followed, chatId])).slice(-50);
    this._saveSettings();
    this._emitState();
  }

  unfollow(chatId) {
    this.router.unfollow(chatId);
    this.settings.followed = this.settings.followed.filter((id) => id !== chatId);
    this._saveSettings();
    this._emitState();
  }

  dismiss(itemId) {
    if (this.router.dismiss(itemId)) {
      this._dropItems([itemId]);
      this._emitState();
    }
  }

  /** Opens a card's chat in the Claude desktop app. Only claude:// chat addresses pass. */
  open(itemId) {
    const item = this.router.get(itemId);
    if (
      !item?.openUrl ||
      !/^claude:\/\/claude\.ai\/epitaxy\/local_[0-9a-f-]{36}$/i.test(item.openUrl)
    ) {
      return false;
    }
    this.openUrlHandler(item.openUrl);
    return true;
  }

  /** Barge-in and the "stop" command: silence now, and drop what was queued or being made. */
  stop() {
    this.generation += 1;
    this._settleQueued();
    this.queue = [];
    this.answers.close();
    if (this.current) this.current.cancelled = true;
    this.current?.playback?.cancel();
    this.stopPlayback();
    this._emitState();
  }

  // ------------------------------------------------------- voice questions

  /**
   * A chat's question through the ask_by_voice tool: said out loud with its
   * choices, then answered with the dictation key. Resolves within
   * QUESTION_DEADLINE_MS with exactly what the tool returns: {answer} or
   * {answer: null, reason}. "not_active" means nothing was said.
   *
   * @param {{question: string, choices: string[], chat: string, sessionId?: string|null, cwd?: string}} ask
   * @param {{signal?: AbortSignal}} [opts]   aborted when the chat stops waiting
   */
  async askByVoice(ask, { signal } = {}) {
    const calledAt = this.now();
    if (!this.takesVoiceQuestions || signal?.aborted) return NOT_ACTIVE;
    const language = questionLanguage(
      `${ask.question} ${ask.choices.join(" ")}`,
      this.settings.language
    );
    if (!this._voiceFor(language, { quick: true })) return NOT_ACTIVE;
    if (!(await this._inNarratorMode(ask.sessionId, ask.cwd))) return NOT_ACTIVE;
    // Settings can change while the chat's transcript was read.
    if (!this.takesVoiceQuestions || signal?.aborted) return NOT_ACTIVE;

    const job = this._job({
      kind: "question",
      id: `q${++this.questionCount}`,
      ask,
      language,
      startBy: calledAt + QUESTION_START_BY_MS,
      closeBy: calledAt + QUESTION_CLOSE_BY_MS,
      deadline: calledAt + QUESTION_DEADLINE_MS,
      spoken: false,
    });
    const outcome = new Promise((resolve) => {
      job.resolve = resolve;
    });
    const drop = () => this._dropQuestion(job);
    signal?.addEventListener("abort", drop, { once: true });
    const timer = setTimeout(drop, QUESTION_DEADLINE_MS);
    timer.unref?.();
    // Still waiting behind other speech when its window could no longer be whole: it stays unsaid.
    const late = setTimeout(() => {
      if (!job.started) drop();
    }, QUESTION_START_BY_MS);
    late.unref?.();
    // Ahead of other speech, since a chat is blocked on it; behind questions already waiting.
    const at = this.queue.findIndex((queued) => queued.kind !== "question");
    this.queue.splice(at < 0 ? this.queue.length : at, 0, job);
    this._emitState();
    void this._drain();
    try {
      const reply = this._reply(job, await outcome);
      this._questionEnded(job, reply);
      return reply;
    } finally {
      clearTimeout(timer);
      clearTimeout(late);
      signal?.removeEventListener("abort", drop);
    }
  }

  async _inNarratorMode(sessionId, cwd) {
    if (!this.settings.onlyNarratorMode) return true;
    try {
      return (await this.narratorModes.modeOfSession(sessionId, { cwd })) === true;
    } catch {
      return false;
    }
  }

  /** What the tool returns for how a question ended. */
  _reply(job, outcome) {
    if (!job.spoken) return NOT_ACTIVE;
    if (outcome?.result === "picked" && job.ask.choices.includes(outcome.label)) {
      return { answer: outcome.label };
    }
    if (outcome?.result === "cancelled") return { answer: null, reason: "cancelled" };
    const missed = outcome?.missed ?? (this.question?.id === job.id ? this.question.missed : 0);
    return { answer: null, reason: missed > 0 ? "no_match" : "no_answer" };
  }

  _questionEnded(job, reply) {
    if (this.question?.id === job.id) {
      Object.assign(this.question, {
        phase: "done",
        result: reply.answer ? "answered" : reply.reason,
        picked: reply.answer || null,
        windowEndsAt: null,
        confirmEndsAt: null,
        endedAt: this.now(),
      });
    }
    if (job.spoken) {
      const key = job.ask.sessionId || job.id;
      if (reply.answer) this.missed.delete(key);
      else this.missed.set(key, { chat: job.ask.chat, at: this.now() });
    }
    this._emitState();
  }

  /** Ends one question now, queued or being asked; its chat gets its answer at once. */
  _dropQuestion(job) {
    job.cancelled = true;
    this.queue = this.queue.filter((queued) => queued !== job);
    if (this.current === job) {
      job.chimePlayback?.cancel();
      job.playback?.cancel();
      this.answers.close("stopped");
    }
    job.resolve?.({ result: "stopped" });
  }

  /** Questions end when gaming mode, Answer by voice or local transcription go off. */
  _dropQuestionsIfOff() {
    if (this.takesVoiceQuestions) return;
    const questions = this.queue.filter((job) => job.kind === "question");
    if (this.current?.kind === "question") questions.push(this.current);
    for (const job of questions) this._dropQuestion(job);
  }

  /** Every queued question learns that it will not be asked. */
  _settleQueued() {
    for (const job of this.queue) job.resolve?.({ result: "stopped" });
    if (this.current?.kind === "question") this.current.resolve?.({ result: "stopped" });
  }

  /** The answer window moved on: the overlay shows where it is. */
  _onAnswerChange() {
    const snapshot = this.answers.snapshot();
    if (snapshot && this.question && this.current?.id === this.question.id) {
      let phase = snapshot.phase;
      if (phase === "asking") phase = snapshot.missed > 0 ? "not-caught" : "speaking";
      Object.assign(this.question, {
        phase,
        windowEndsAt: snapshot.windowEndsAt,
        picked: snapshot.picked,
        confirmEndsAt: snapshot.confirmEndsAt,
        missed: snapshot.missed,
        ended: snapshot.ended || null,
      });
    }
    this._emitState();
  }

  /** Cards of chats that are not in narrator mode go, once the switch asks for it. */
  async _pruneOutOfMode() {
    for (const chatId of new Set(this.router.snapshot().map((item) => item.chatId))) {
      const on = await this.narratorModes.modeOfSession(chatId).catch(() => null);
      if (on === true || !this.settings.onlyNarratorMode) continue;
      this._dropItems(this.router.removeChat(chatId));
    }
    this._emitState();
  }

  /** Chats waiting on the user: open waits, and voice questions left unanswered. */
  _waitingCount() {
    const chats = new Set(
      this.router
        .snapshot()
        .filter((item) => item.kind === "waiting")
        .map((item) => item.chatId)
    );
    const cutoff = this.now() - MISSED_TTL_MS;
    for (const [key, missed] of this.missed) {
      if (missed.at < cutoff) this.missed.delete(key);
      else chats.add(key);
    }
    return chats.size;
  }

  /** Speaks a fixed sentence in a language, for the page's voice check. */
  test(language) {
    const lang = language === "en" ? "en" : "da";
    this._say(PHRASES[lang].test, lang, { chime: true });
  }

  // ---------------------------------------------------------------- speech

  _job(fields) {
    return { generation: this.generation, cancelled: false, chime: false, ...fields };
  }

  _say(text, language, { chime = false } = {}) {
    this._enqueue(this._job({ kind: "say", text, language, chime }));
  }

  /** Whether a job may still make a sound. */
  _alive(job) {
    if (job.cancelled || job.generation !== this.generation) return false;
    return !job.itemId || Boolean(this.router.get(job.itemId));
  }

  /** The chime on its own, played while the item's rewrite is made. */
  _chime() {
    const playback = this.openPlayback({ chime: true });
    playback.end();
    return playback;
  }

  _enqueue(job) {
    this.queue.push(job);
    this._emitState();
    void this._drain();
  }

  async _drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift();
        if (!this._alive(job)) {
          job.resolve?.({ result: "stopped" });
          continue;
        }
        this.current = job;
        try {
          await this._run(job);
        } catch (error) {
          this.debug("Narrator could not speak an item", {
            error: String(error?.message || error),
          });
        } finally {
          this.current = null;
          // A question always gets its answer, however its turn ended.
          job.resolve?.({ result: "stopped" });
        }
      }
    } finally {
      this.draining = false;
      this._emitState();
    }
  }

  /**
   * A chat's wrap_up says what its turn ends with before the turn is over:
   * the closing words still stream and the Stop hooks still run, seconds in
   * all. A turn that will be spoken is rewritten from then on, so its words
   * can follow its chime. That also hides the model's thinking, which Haiku
   * does at will, often for 5 s on a process's first rewrite, and which no
   * CLI setting turns off. A turn that goes on after all costs one rewrite.
   */
  _prefetch(event) {
    // A question said through ask_by_voice is not said again.
    if (!this.running || event.voiceAsked) return;
    const spoken = this.router.isFollowed(event.chatId) && !this.settings.gaming;
    if (event.kind !== "waiting" && !spoken) return;
    const language = this.settings.language;
    const key = this._prefetchKey(event, language);
    if (this.prefetched.has(key)) return;
    // Its turn ended in the same read and was taken in first.
    if (this.router.snapshot().some((item) => this._prefetchKey(item, language) === key)) return;
    const pending = this.rewriter.rewrite(
      {
        chatId: event.chatId,
        chatTitle: event.chatTitle || "",
        project: event.project || "",
        kind: event.kind,
        recap: event.recap || "",
        ask: event.ask || "",
      },
      language
    );
    this.prefetched.set(key, pending);
    pending.catch(() => this.prefetched.delete(key));
    if (this.prefetched.size > 20) this.prefetched.delete(this.prefetched.keys().next().value);
  }

  /** Everything a rewrite reads, so an early one is used only for the same words. */
  _prefetchKey(item, language) {
    const fields = [item.chatId, item.kind, item.chatTitle, item.project, item.recap, item.ask];
    return [...fields.map((field) => field || ""), language].join("\n");
  }

  _rewrite(item, language) {
    const key = `${item.id}:${language}`;
    if (!this.rewrites.has(key)) {
      const early = this._prefetchKey(item, language);
      const pending = this.prefetched.get(early) || this.rewriter.rewrite(item, language);
      this.prefetched.delete(early);
      this._remember(key, pending, item, language);
    }
    return this.rewrites.get(key);
  }

  _remember(key, pending, item, language) {
    const kept = pending.then((result) => {
      if (language === this.settings.language || !item.card) item.card = result.card;
      return result;
    });
    this.rewrites.set(key, kept);
    kept.catch(() => this.rewrites.delete(key));
    if (this.rewrites.size > 200) this.rewrites.delete(this.rewrites.keys().next().value);
  }

  /** Rewrites for every item of a brief in one request; already-made ones are reused. */
  async _rewriteMany(items, language) {
    const missing = items.filter((item) => !this.rewrites.has(`${item.id}:${language}`));
    if (missing.length > 0) {
      const batch = this.rewriter.rewriteMany(missing, language);
      missing.forEach((item, index) =>
        this._remember(
          `${item.id}:${language}`,
          batch.then((results) => results[index]),
          item,
          language
        )
      );
    }
    return Promise.all(items.map((item) => this.rewrites.get(`${item.id}:${language}`)));
  }

  async _run(job) {
    if (job.kind === "say") {
      await this._speak(job.text, job.language, { job });
      return;
    }

    if (job.kind === "question") {
      await this._runQuestion(job);
      return;
    }

    if (job.kind === "interrupt" || job.kind === "followed") {
      const item = this.router.get(job.itemId);
      if (!item || item.heard) return;
      // Gaming mode was switched on while it waited in the queue.
      if (job.kind === "followed" && this.settings.gaming) return;
      if (job.kind === "interrupt" && !job.chimePlayback) job.chimePlayback = this._chime();
      const language = this.settings.language;
      // Listening starts with the chime, so a pause that began during it counts.
      const call = this.settings.makeRoom ? this.room?.watchCall?.() : null;
      let rewrite;
      try {
        [rewrite] = await Promise.all([this._rewrite(item, language), job.chimePlayback?.result]);
        if (!this._alive(job)) return;
        // Made while the call talks, so the words start the moment a pause comes.
        job.firstPart = this._prepare(rewrite.spoken, language);
        if (call) job.pause = await call.waitForPause({ isAlive: () => this._alive(job) });
      } finally {
        call?.close();
      }
      if (!this._alive(job)) return;
      await this._speak(rewrite.spoken, language, {
        job,
        item,
        onHeard: () => this.router.markHeard(item.id),
      });
      return;
    }

    if (job.kind === "brief") {
      const language = job.language;
      const phrases = PHRASES[language];
      const items = this.router.briefItems();
      if (items.length === 0) {
        await this._speak(phrases.nothing, language, { job });
        return;
      }
      const rewrites = await this._rewriteMany(items, language);
      if (!this._alive(job)) return;
      // An item answered while the brief was made is left out of it.
      const kept = items
        .map((item, index) => ({ item, rewrite: rewrites[index] }))
        .filter(({ item }) => this.router.get(item.id));
      if (kept.length === 0) {
        await this._speak(phrases.nothing, language, { job });
        return;
      }
      const unheard = this.router.unheardCount();
      const parts = [phrases.count(unheard), ...kept.map(({ rewrite }) => rewrite.spoken)];
      if (unheard > kept.length) parts.push(phrases.rest(unheard - kept.length));
      await this._speak(parts.join(" "), language, {
        job,
        // The item said last is the one "tell me more" is about.
        onHeard: () => kept.forEach(({ item }) => this.router.markHeard(item.id)),
      });
      return;
    }

    if (job.kind === "more") {
      const language = job.language;
      const item = this.router.current();
      if (!item) {
        await this._speak(PHRASES[language].noCurrent, language, { job });
        return;
      }
      const rewrite = await this._rewrite(item, language);
      if (!this._alive(job)) return;
      await this._speak(rewrite.more || rewrite.spoken, language, { job, item });
    }
  }

  async _runQuestion(job) {
    // Too late for a full answer window: it stays in the chat, unsaid.
    if (this.now() > job.startBy) return;
    job.started = true;
    const { ask, language } = job;
    const text = ANSWER_PHRASES[language].question(ask.chat, ask.question, ask.choices);
    job.chimePlayback = this._chime();
    // From the chime on the key is the question's: until its first word a
    // press does nothing, since as a dictation it would be pasted into the
    // game or the call. The chime waits for a dictation in progress, so that
    // one still ends with the key.
    let unsaid = () => {};
    let over = false;
    void job.chimePlayback.started.then((at) => {
      if (!at || over || !this._alive(job)) return;
      unsaid = this.answers.announce({ isAlive: () => this._alive(job), until: job.closeBy });
    });
    try {
      return await this._chimeThenAsk(job, text);
    } finally {
      over = true;
      // After a stop the key goes back at once: a dictation that barged in
      // during the chime must end with its next press.
      unsaid({ grace: job.generation === this.generation });
    }
  }

  async _chimeThenAsk(job, text) {
    const { ask, language } = job;
    const call = this.settings.makeRoom ? this.room?.watchCall?.() : null;
    try {
      job.firstPart = this._prepare(text, language, job);
      await job.chimePlayback.result;
      if (call && this._alive(job)) {
        job.pause = await call.waitForPause({
          maxMs: QUESTION_PAUSE_MS,
          isAlive: () => this._alive(job),
        });
      }
    } finally {
      call?.close();
    }
    if (!this._alive(job)) return;
    // Held back by a dictation or a busy call: too late for a whole answer
    // window, so it stays unsaid and the chat hears so at once.
    if (this.now() > job.startBy + QUESTION_PAUSE_MS) {
      job.resolve({ result: "late" });
      return;
    }
    const outcome = await this._askAndListen(job, {
      text,
      language,
      chatName: ask.chat,
      options: ask.choices,
      closeBy: job.closeBy,
      deadline: job.deadline,
      onHeard: () => {
        job.spoken = true;
        // The overlay shows the question from its first word, which is also
        // when the key starts answering it: before that, a press does nothing.
        this.question = {
          id: job.id,
          chat: ask.chat,
          question: ask.question,
          choices: ask.choices.slice(),
          language,
          phase: "speaking",
          windowEndsAt: null,
          picked: null,
          confirmEndsAt: null,
          missed: 0,
          ended: null,
          result: null,
          startedAt: this.now(),
          endedAt: null,
        };
      },
    });
    job.resolve(outcome);
  }

  /**
   * `quick`: a voice question, whose answer window closes 27 s after the call.
   * Røst takes about half a minute to start a line on the processor, so a
   * Danish question always uses Piper.
   */
  _voiceFor(language, { quick = false } = {}) {
    if (language === "en") return this.voices["kokoro-en"] || null;
    if (quick) return this.voices["piper-da"] || null;
    const roestDown = this.settings.voiceDa === "roest-da" && this.roestDownUntil > this.now();
    return (!roestDown && this.voices[this.settings.voiceDa]) || this.voices["piper-da"] || null;
  }

  async _synthesize(voice, sentence) {
    const timeout = SYNTH_TIMEOUT_MS[voice.id] || 30_000;
    return withTimeout(voice.synthesize(sentence), timeout, `The ${voice.id} voice did not answer`);
  }

  /** Starts making the first sentence of `text`; _play uses it if nothing changed meanwhile. */
  _prepare(text, language, job = null) {
    const spoken = toSpeakable(text);
    const voice = spoken ? this._voiceFor(language, { quick: job?.kind === "question" }) : null;
    const sentence = voice ? splitSentences(spoken)[0] : null;
    if (!sentence) return null;
    const part = this._synthesize(voice, sentence);
    // A failure surfaces when _play uses the part, with the usual fallback.
    part.catch(() => {});
    return { voiceId: voice.id, sentence, part };
  }

  /**
   * Speaks `text` sentence by sentence: the first plays as soon as it is made,
   * the rest follow as they are made. `onHeard` runs once the first sound
   * plays, so an item a broken voice never said stays new. Logs what was
   * actually heard. Resolves with how the playback ended ("done", "stopped",
   * ...), or null when nothing played.
   *
   * `holdRoom`: the caller keeps other apps lowered across several lines.
   * `record`: false for a voice answer's short lines, which are neither the
   * last playback nor in the log.
   */
  async _speak(
    text,
    language,
    {
      job,
      item = null,
      onHeard = () => {},
      holdRoom = false,
      record = true,
      chime = Boolean(job?.chime),
    } = {}
  ) {
    const spoken = toSpeakable(text);
    if (!spoken || !this._alive(job)) return null;
    const voice = this._voiceFor(language, { quick: job?.kind === "question" });
    if (!voice) {
      this.voiceError = { language, code: "voice-missing", message: "No voice for this language" };
      this._emitState();
      return null;
    }

    const playback = this.openPlayback({ chime });
    job.playback = playback;
    job.speaking = { itemId: item?.id || null, language };
    playback.started.then((at) => {
      if (!at) return;
      onHeard();
      this._emitState();
    });
    this._emitState();
    // Not awaited, as for Read Aloud: lowering other apps must never hold up
    // the first word. Putting them back is awaited, once the words have ended.
    const ducking = !holdRoom && this._makesRoom() ? this._duck() : null;
    let played = false;
    try {
      played = await this._play(playback, spoken, voice, language, job);
    } finally {
      if (ducking) await this._undo(ducking);
    }
    if (!played) return "stopped";

    const result = await playback.result;
    const startedAt = await playback.started;
    job.speaking = null;
    if (!record) {
      this._emitState();
      return result;
    }
    // How long after its turn ended a chat was heard: the chime, then the words.
    const live = item && (job.kind === "interrupt" || job.kind === "followed");
    const chimeAt = (await job.chimePlayback?.started) || startedAt;
    const latencyMs = live && startedAt ? startedAt - item.at : null;
    this.lastPlayback = {
      result,
      chime: Boolean(job.chime || job.chimePlayback),
      language,
      at: startedAt,
      latencyMs,
      chimeLatencyMs: live && job.chimePlayback && chimeAt ? chimeAt - item.at : null,
      pause: job.pause || null,
      ducked: ducking ? await ducking : false,
    };
    if (startedAt) {
      this.log.append({
        kind: job.kind,
        result,
        chatId: item?.chatId,
        chatTitle: item ? redact(item.chatTitle, 200) : undefined,
        text: spoken,
        language,
        latencyMs,
      });
    }
    this._emitState();
    return result;
  }

  _makesRoom() {
    return Boolean(this.settings.makeRoom && this.room?.duck);
  }

  /**
   * Says a question, then holds the answer window open after it. Other apps
   * stay lowered from the question to the outcome and come back once. Resolves
   * with the outcome: {result: "picked", label} or {result} for anything else.
   */
  async _askAndListen(
    job,
    {
      text,
      language,
      chatName,
      options,
      item = null,
      onHeard = () => {},
      closeBy = Infinity,
      deadline = Infinity,
    }
  ) {
    const ducking = this._makesRoom() ? this._duck() : null;
    let answer = null;
    try {
      const result = await this._speak(text, language, {
        job,
        item,
        holdRoom: true,
        onHeard: () => {
          onHeard();
          // From its first word: a press while it is still said is an answer.
          answer = this.answers.ask({
            chatName,
            options,
            language,
            say: (line) =>
              this._speak(line, language, { job, holdRoom: true, record: false, chime: false }),
            stopSpeech: () => job.playback?.cancel(),
            isAlive: () => this._alive(job),
            closeBy,
            deadline,
          });
          this._emitState();
        },
      });
      if (!answer) return { result: "not-heard" };
      answer.questionDone(result === "done");
      return await answer.outcome;
    } finally {
      answer?.close("stopped");
      if (ducking) await this._undo(ducking);
      this._emitState();
    }
  }

  /** Lowers other apps; resolves true once this narrator holds the duck. */
  _duck() {
    return Promise.resolve()
      .then(() => this.room.duck())
      .then(
        (held) => held !== false,
        (error) => {
          this.debug("Narrator could not lower other apps", {
            error: String(error?.message || error),
          });
          return false;
        }
      );
  }

  async _undo(ducking) {
    if (!(await ducking)) return;
    try {
      await this.room.restore();
    } catch (error) {
      this.debug("Narrator could not put other apps back", {
        error: String(error?.message || error),
      });
    }
  }

  /**
   * Sends one item's sentences to the overlay as they are made, then waits for
   * it to finish playing. Throws, after cancelling the playback, if the voice
   * fails.
   */
  async _play(playback, spoken, voice, language, job) {
    try {
      for (const [index, sentence] of splitSentences(spoken).entries()) {
        const ready = index === 0 ? job.firstPart : null;
        let part;
        try {
          part =
            ready && ready.voiceId === voice.id && ready.sentence === sentence
              ? await ready.part
              : await this._synthesize(voice, sentence);
        } catch (error) {
          // Røst failing hands the item to Piper, and Danish stays on Piper
          // for a while rather than waiting out a broken Røst on every item.
          if (voice.id !== "roest-da" || !this.voices["piper-da"]) throw error;
          this.debug("Røst failed; using Piper", { error: String(error?.message || error) });
          voice.unload?.();
          this.roestDownUntil = this.now() + ROEST_RETRY_MS;
          voice = this.voices["piper-da"];
          part = await this._synthesize(voice, sentence);
        }
        if (!this._alive(job)) {
          playback.cancel();
          return false;
        }
        playback.push(part);
      }
      playback.end();
      this.voiceError = null;
    } catch (error) {
      playback.cancel();
      this.voiceError = {
        language,
        code: error?.code || "error",
        message: String(error?.message || error),
      };
      this._emitState();
      throw error;
    }
    await playback.result;
    return true;
  }

  // ----------------------------------------------------------------- state

  getState() {
    return {
      running: this.running,
      enabled: this.settings.enabled,
      gate: this.gate,
      settings: { ...this.settings },
      items: this.router.snapshot().map((item) => ({
        id: item.id,
        voiceAsked: Boolean(item.voiceAsked),
        chatId: item.chatId,
        chatTitle: redact(item.chatTitle, 200),
        project: item.project,
        kind: item.kind,
        card: redact(item.card || item.ask || item.recap, 600),
        recap: redact(item.recap, 2000),
        ask: redact(item.ask, 600),
        at: item.at,
        heard: item.heard,
        canOpen: Boolean(item.openUrl),
        followed: item.followed,
      })),
      speaking: this.current?.speaking || null,
      queued: this.queue.length,
      voiceError: this.voiceError,
      lastPlayback: this.lastPlayback,
      localOnly: this.localOnly,
      answering: this.answers.active,
      takesVoiceQuestions: this.takesVoiceQuestions,
      question: this.question
        ? {
            ...this.question,
            chat: redact(this.question.chat, 60),
            question: redact(this.question.question, 300),
            choices: this.question.choices.map((choice) => redact(choice, 80)),
          }
        : null,
      waiting: this._waitingCount(),
      rewriterError: this.rewriter.lastError || null,
      week: this.log.countSince(this.now() - WEEK_MS),
    };
  }

  _emitState() {
    try {
      this.onState(this.getState());
    } catch {
      // A closed window is not the narrator's problem.
    }
  }

  // -------------------------------------------------------------- settings

  _settingsFile() {
    return this.dataDir ? path.join(this.dataDir, "narrator-settings.json") : null;
  }

  _loadSettings() {
    const file = this._settingsFile();
    if (!file) return { ...DEFAULT_SETTINGS };
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      return {
        ...DEFAULT_SETTINGS,
        ...saved,
        followed: Array.isArray(saved.followed)
          ? saved.followed.filter((id) => typeof id === "string")
          : [],
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  _saveSettings() {
    const file = this._settingsFile();
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(this.settings, null, 2));
    } catch (error) {
      this.debug("Narrator could not save its settings", { error: error.message });
    }
  }
}

module.exports = { Narrator, DEFAULT_SETTINGS, PHRASES };
