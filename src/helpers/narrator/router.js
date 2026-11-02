"use strict";

/**
 * Decides what the narrator says out loud and what it only shows. Pure state:
 * events in, decisions out, no timers and no audio, so the rules below are
 * tested without a voice.
 *
 *   waits on the user     → interrupt: chime, spoken at once, one at a time
 *   finished              → card, kept for "what's new?"
 *   finished, followed    → spoken like a wait, without the chime
 *   user wrote in chat    → the chat's items leave the queue
 *
 * Every item is spoken once. A brief speaks the items not yet heard and marks
 * them heard; "tell me more" and "follow that chat" act on the item heard
 * last. A turn is news once: one read a second time is ignored, even after
 * its card is gone.
 */

/** Cards kept at most; the oldest heard ones go first. */
const MAX_ITEMS = 50;
/** Items spoken in one brief, newest waits first; the rest stay as cards. */
const MAX_BRIEF_ITEMS = 4;
/** How long a turn already taken in stays known, and how many are kept. */
const SEEN_MS = 24 * 60 * 60 * 1000;
const MAX_SEEN = 1000;

/**
 * What makes a turn the same turn wherever it shows up: its time and its
 * words. A transcript read again after it was rewritten gives the same turn
 * back, and so does a forked chat, which copies the turns before the fork
 * with their times into a new chat. Null for an event without a time.
 */
function turnSignature(event) {
  if (!Number.isFinite(event.at)) return null;
  return [event.kind, event.at, event.ask || "", event.recap || ""].join("\n");
}

/**
 * @typedef {object} NarratorEvent
 * @property {"waiting"|"finished"|"answered"} kind
 * @property {string} chatId           stable per chat (the transcript's session id)
 * @property {string} [chatTitle]
 * @property {string} [recap]
 * @property {string} [ask]
 * @property {number} at               epoch ms
 * @property {boolean} [backlog]       found at startup, not live
 * @property {boolean} [provisional]   a wrap_up whose turn has not ended; the narrator
 *                                     starts its rewrite and never routes it here
 * @property {string} [openUrl]        how to open the chat, when known
 * @property {string} [source]         "claude-code", later "codex"
 */

class NarratorRouter {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    /** @type {Array<object>} newest last */
    this.items = [];
    this.followed = new Set();
    this.currentId = null;
    this.nextId = 1;
    /** turn signature -> when it was taken in, oldest first */
    this.seen = new Map();
  }

  /**
   * Takes one event and says what to do with it.
   * @param {NarratorEvent} event
   * @returns {{ action: "interrupt"|"speak"|"card"|"removed"|"ignore", item?: object, removed?: string[] }}
   */
  ingest(event) {
    if (!event || typeof event.chatId !== "string" || !event.chatId) return { action: "ignore" };

    if (event.kind === "answered") {
      const removed = this.items.filter((item) => item.chatId === event.chatId);
      if (removed.length === 0) return { action: "ignore" };
      this.items = this.items.filter((item) => item.chatId !== event.chatId);
      if (removed.some((item) => item.id === this.currentId)) this.currentId = null;
      return { action: "removed", removed: removed.map((item) => item.id) };
    }

    if (event.kind !== "waiting" && event.kind !== "finished") return { action: "ignore" };
    if (!event.recap && !event.ask) return { action: "ignore" };

    // The same wait reported twice (a repeated wrap_up, a restart) is one
    // item, spoken once.
    const same = this.items.find(
      (item) =>
        item.chatId === event.chatId &&
        item.kind === event.kind &&
        item.ask === (event.ask || "") &&
        item.recap === (event.recap || "")
    );
    if (same) return { action: "ignore", item: same };
    const signature = turnSignature(event);
    if (signature) {
      if (this._seen(signature)) return { action: "ignore" };
      this._remember(signature);
    }

    // A chat holds one item: its newest state replaces the older one, so a
    // chat that finished and then asked is one card, not two.
    this.items = this.items.filter((item) => item.chatId !== event.chatId);
    const item = {
      id: `n${this.nextId++}`,
      chatId: event.chatId,
      chatTitle: event.chatTitle || "",
      project: event.project || "",
      kind: event.kind,
      recap: event.recap || "",
      ask: event.ask || "",
      at: Number.isFinite(event.at) ? event.at : this.now(),
      openUrl: event.openUrl || "",
      source: event.source || "claude-code",
      heard: false,
      spoken: null,
      card: null,
      more: null,
    };
    this.items.push(item);
    this._trim();

    if (event.backlog) return { action: "card", item };
    if (item.kind === "waiting") return { action: "interrupt", item };
    if (this.followed.has(item.chatId)) return { action: "speak", item };
    return { action: "card", item };
  }

  /** Marks an item heard and makes it the one "tell me more" refers to. */
  markHeard(id) {
    const item = this.get(id);
    if (!item) return null;
    item.heard = true;
    this.currentId = id;
    return item;
  }

  get(id) {
    return this.items.find((item) => item.id === id) || null;
  }

  /** The items a brief speaks: unheard, waits before finishes, newest first. */
  briefItems(limit = MAX_BRIEF_ITEMS) {
    const unheard = this.items.filter((item) => !item.heard);
    const order = (item) => (item.kind === "waiting" ? 0 : 1);
    return unheard.sort((a, b) => order(a) - order(b) || b.at - a.at).slice(0, Math.max(0, limit));
  }

  /** How many items a brief would leave out. */
  unheardCount() {
    return this.items.filter((item) => !item.heard).length;
  }

  current() {
    return this.currentId ? this.get(this.currentId) : null;
  }

  /** Every finish in this chat speaks from now on. Returns the chat id or null. */
  follow(chatId) {
    if (!chatId) return null;
    this.followed.add(chatId);
    return chatId;
  }

  unfollow(chatId) {
    this.followed.delete(chatId);
  }

  isFollowed(chatId) {
    return this.followed.has(chatId);
  }

  dismiss(id) {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== id);
    if (this.currentId === id) this.currentId = null;
    return this.items.length !== before;
  }

  /** Forgets every item and every turn taken in; followed chats stay followed. */
  clear() {
    this.items = [];
    this.seen.clear();
    this.currentId = null;
  }

  /** A copy for the UI, newest first. */
  snapshot() {
    return this.items
      .slice()
      .reverse()
      .map((item) => ({ ...item, followed: this.followed.has(item.chatId) }));
  }

  _seen(signature) {
    const at = this.seen.get(signature);
    return at !== undefined && this.now() - at <= SEEN_MS;
  }

  _remember(signature) {
    const now = this.now();
    this.seen.set(signature, now);
    for (const [key, at] of this.seen) {
      if (now - at <= SEEN_MS && this.seen.size <= MAX_SEEN) break;
      this.seen.delete(key);
    }
  }

  _trim() {
    while (this.items.length > MAX_ITEMS) {
      const index = this.items.findIndex((item) => item.heard);
      this.items.splice(index >= 0 ? index : 0, 1);
    }
  }
}

module.exports = { NarratorRouter, MAX_ITEMS, MAX_BRIEF_ITEMS };
