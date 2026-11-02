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
 * A wait chimes the moment it is seen, or when its turn comes if something
 * else is being said, and is spoken once its rewrite is back, a few seconds
 * later. The chime is a playback of its own, so an item counts as heard only
 * once its words play. Each sentence plays as soon as it is made. Stop, switching off, and an answer in the chat all cut off
 * the item they concern, including one still being rewritten or made.
 *
 * It never answers a chat. Speech recognition can invent a "yes", so every
 * answer stays in the chat itself.
 */

const fs = require("node:fs");
const path = require("node:path");
const { NarratorRouter } = require("./router");
const { NarratorRewriter } = require("./rewriter");
const { ClaudeTranscriptSource } = require("./claudeTranscriptSource");
const { matchCommand } = require("./commands");
const { toSpeakable, splitSentences, redact } = require("./spokenText");
const { NarratorLog } = require("./narratorLog");

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
   * @param {(url: string) => void} [deps.openUrl]
   * @param {(state: object) => void} [deps.onState]
   */
  constructor({
    dataDir = null,
    openPlayback,
    stopPlayback = () => {},
    voices = {},
    createSource,
    rewriter,
    openUrl = () => {},
    onState = () => {},
    log = () => {},
    now = () => Date.now(),
  }) {
    this.dataDir = dataDir;
    this.openPlayback = openPlayback;
    this.stopPlayback = stopPlayback;
    this.voices = voices;
    this.createSource = createSource || ((onEvent) => new ClaudeTranscriptSource({ onEvent, log }));
    this.rewriter = rewriter || new NarratorRewriter({ log });
    this.openUrlHandler = openUrl;
    this.onState = onState;
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
    const previous = this.settings;
    this.settings = next;
    this._saveSettings();
    if (next.voiceDa !== previous.voiceDa) {
      // Røst holds gigabytes of model while it runs; a voice set aside lets go of it.
      this.voices[previous.voiceDa]?.unload?.();
      this.roestDownUntil = 0;
    }
    this._apply();
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
      this.rewriter.close?.();
      for (const voice of Object.values(this.voices)) voice?.unload?.();
    }
    this._emitState();
  }

  dispose() {
    this.source?.stop();
    this.source = null;
    this.generation += 1;
    this.queue = [];
    this.current?.playback?.cancel();
    this.rewriter.close?.();
    for (const voice of Object.values(this.voices)) voice?.unload?.();
  }

  // ---------------------------------------------------------------- events

  ingest(event) {
    const decision = this.router.ingest(event);
    // Every card that turned up while it ran counts; cards from startup do not.
    if (["interrupt", "speak", "card"].includes(decision.action) && !event.backlog) {
      this.log.append({
        kind: "card",
        chatId: decision.item.chatId,
        chatTitle: redact(decision.item.chatTitle, 200),
      });
    }
    if (decision.action === "interrupt" || decision.action === "speak") {
      // Rewritten at once, so an item queued behind other speech is ready when its turn comes.
      void this._rewrite(decision.item, this.settings.language);
    }
    if (decision.action === "interrupt") {
      const job = this._job({ kind: "interrupt", itemId: decision.item.id });
      // The chime goes out now, while the rewrite is made, unless something is
      // being said: then it sounds when the item's turn comes (_run).
      if (!this.current && this.queue.length === 0) job.chimePlayback = this._chime();
      this._enqueue(job);
    } else if (decision.action === "speak") {
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
    this.queue = [];
    if (this.current) this.current.cancelled = true;
    this.current?.playback?.cancel();
    this.stopPlayback();
    this._emitState();
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
        if (!this._alive(job)) continue;
        this.current = job;
        try {
          await this._run(job);
        } catch (error) {
          this.debug("Narrator could not speak an item", {
            error: String(error?.message || error),
          });
        } finally {
          this.current = null;
        }
      }
    } finally {
      this.draining = false;
      this._emitState();
    }
  }

  _rewrite(item, language) {
    const key = `${item.id}:${language}`;
    if (!this.rewrites.has(key)) {
      this._remember(key, this.rewriter.rewrite(item, language), item, language);
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

    if (job.kind === "interrupt" || job.kind === "followed") {
      const item = this.router.get(job.itemId);
      if (!item || item.heard) return;
      if (job.kind === "interrupt" && !job.chimePlayback) job.chimePlayback = this._chime();
      const language = this.settings.language;
      const [rewrite] = await Promise.all([
        this._rewrite(item, language),
        job.chimePlayback?.result,
      ]);
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

  _voiceFor(language) {
    if (language === "en") return this.voices["kokoro-en"] || null;
    const roestDown = this.settings.voiceDa === "roest-da" && this.roestDownUntil > this.now();
    return (!roestDown && this.voices[this.settings.voiceDa]) || this.voices["piper-da"] || null;
  }

  async _synthesize(voice, sentence) {
    const timeout = SYNTH_TIMEOUT_MS[voice.id] || 30_000;
    return withTimeout(voice.synthesize(sentence), timeout, `The ${voice.id} voice did not answer`);
  }

  /**
   * Speaks `text` sentence by sentence: the first plays as soon as it is made,
   * the rest follow as they are made. `onHeard` runs once the first sound
   * plays, so an item a broken voice never said stays new. Logs what was
   * actually heard.
   */
  async _speak(text, language, { job, item = null, onHeard = () => {} } = {}) {
    const spoken = toSpeakable(text);
    if (!spoken || !this._alive(job)) return;
    let voice = this._voiceFor(language);
    if (!voice) {
      this.voiceError = { language, code: "voice-missing", message: "No voice for this language" };
      this._emitState();
      return;
    }

    const playback = this.openPlayback({ chime: Boolean(job.chime) });
    job.playback = playback;
    job.speaking = { itemId: item?.id || null, language };
    playback.started.then((at) => {
      if (!at) return;
      onHeard();
      this._emitState();
    });
    this._emitState();
    try {
      for (const sentence of splitSentences(spoken)) {
        let part;
        try {
          part = await this._synthesize(voice, sentence);
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
          return;
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

    const result = await playback.result;
    const startedAt = await playback.started;
    job.speaking = null;
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
