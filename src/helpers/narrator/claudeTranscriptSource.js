"use strict";

/**
 * Source adapter for Claude Code: follows every chat on this machine by
 * reading the transcripts Claude Code writes under ~/.claude/projects. It only
 * reads. Nothing under ~/.claude is written, moved or locked.
 *
 * Why transcripts and not hooks: a hook must be added to the user's own
 * Claude Code settings, which is a write to ~/.claude and changes every chat.
 * The transcripts are already there for every chat, terminal and desktop app
 * alike, and they carry the desktop app's wrap_up recap and ask.
 *
 * Built for a machine with a lot of history (measured on 2 Nov 2026: 103,176
 * transcripts, 1,330 of them written in the last 12 hours, 334 MB in their
 * tails). So it never lists or stats the whole tree:
 *   - live: one recursive watch reports each transcript as it is appended to,
 *     and only the new bytes are read;
 *   - backlog: the chats the desktop app reports active in the last 12 hours
 *     are read at startup, so a wait already open is not missed. A terminal
 *     chat has no such record and is followed from its next turn on.
 * Every read is asynchronous and cut into whole lines at the byte level, so a
 * line half-written when it is read, or a character split across two reads,
 * is never mangled.
 *
 * A source emits normalised events (see router.js) through `onEvent`, and has
 * start() and stop(). A Codex source for ~/.codex/sessions would be a sibling
 * with the same shape.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { TranscriptState } = require("./transcriptParser");
const { DesktopSessionIndex, desktopChatUrl, projectFolderName } = require("./desktopSessionIndex");

/** A wait this old or newer that the user never answered is still news at startup. */
const BACKLOG_WAIT_MS = 12 * 60 * 60 * 1000;
/** A finished turn is news at startup only if it is this recent. */
const BACKLOG_FINISH_MS = 30 * 60 * 1000;
/** The tail of a transcript read the first time it is seen: the last turns and a title line. */
const TAIL_BYTES = 512 * 1024;
/** A turn that ended longer ago than this is history, not news (a forked chat copies old turns). */
const LIVE_MAX_AGE_MS = 5 * 60 * 1000;
/** Clock for end_turn grace, and the safety net for a missed watch event. */
const POLL_MS = 2000;
/** A file is re-read on a watch event after this pause, so a burst of lines is one read. */
const READ_DEBOUNCE_MS = 150;
/** Files re-checked by the safety net: the ones written to this recently. */
const ACTIVE_WINDOW_MS = 10 * 60 * 1000;
/** The most read from one file in one go; the rest is read on the next pass. */
const MAX_READ_BYTES = 8 * 1024 * 1024;
const NEWLINE = 0x0a;

function defaultRoot() {
  return process.env.PT_NARRATOR_CLAUDE_DIR || path.join(os.homedir(), ".claude", "projects");
}

/** Transcripts sit directly in a project folder; deeper files are subagents. */
function isTopLevelTranscript(relative) {
  const parts = String(relative).split(/[\\/]/);
  return parts.length === 2 && parts[1].endsWith(".jsonl");
}

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

async function readRange(file, start, end) {
  const length = Math.min(end - start, MAX_READ_BYTES);
  if (length <= 0) return Buffer.alloc(0);
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Splits bytes into complete lines. Returns the lines as text and the bytes
 * after the last newline, which wait for the rest of their line.
 */
function splitLines(bytes) {
  const lines = [];
  let start = 0;
  for (let index = bytes.indexOf(NEWLINE); index >= 0; index = bytes.indexOf(NEWLINE, start)) {
    if (index > start) lines.push(bytes.toString("utf8", start, index));
    start = index + 1;
  }
  return { lines, rest: bytes.subarray(start) };
}

class ClaudeTranscriptSource {
  constructor({
    root = defaultRoot(),
    onEvent = () => {},
    log = () => {},
    now = () => Date.now(),
    sessionIndex = new DesktopSessionIndex(),
  } = {}) {
    this.root = root;
    this.onEvent = onEvent;
    this.log = log;
    this.now = now;
    this.sessionIndex = sessionIndex;
    /** file -> entry, for every transcript seen since start */
    this.files = new Map();
    this.watcher = null;
    this.pollTimer = null;
    this.readTimers = new Map();
    this.running = false;
    /** Resolves when the startup backlog has been read; tests and the live check await it. */
    this.ready = Promise.resolve();
  }

  start() {
    if (this.running) return this.ready;
    this.running = true;
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_type, filename) => {
        if (filename && isTopLevelTranscript(filename)) {
          this._scheduleRead(path.join(this.root, String(filename)));
        }
      });
      this.watcher.on("error", (error) => {
        this.log("Narrator transcript watch failed; following known chats only", {
          error: error.message,
        });
        this.watcher?.close();
        this.watcher = null;
      });
    } catch (error) {
      this.log("Narrator could not watch transcripts; following known chats only", {
        error: error.message,
      });
    }
    this.pollTimer = setInterval(() => void this._poll(), POLL_MS);
    this.pollTimer.unref?.();
    this.ready = this._readBacklog().catch((error) => {
      this.log("Narrator could not read the recent chats", { error: error.message });
    });
    return this.ready;
  }

  stop() {
    this.running = false;
    this.watcher?.close();
    this.watcher = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const timer of this.readTimers.values()) clearTimeout(timer);
    this.readTimers.clear();
    this.files.clear();
  }

  /** The recent desktop chats, read once each, so a wait already open becomes a card. */
  async _readBacklog() {
    if (!this.sessionIndex) return;
    await this.sessionIndex.scan();
    const now = this.now();
    for (const record of this.sessionIndex.recent(now - BACKLOG_WAIT_MS)) {
      if (!this.running) return;
      const file = path.join(
        this.root,
        projectFolderName(record.cwd || record.originCwd),
        `${record.cliSessionId}.jsonl`
      );
      if (this.files.has(file)) continue;
      const entry = this._entry(file);
      let last = null;
      await this._read(entry, (event) => {
        if (event.type === "turn-ended") last = event;
        else if (event.type === "answered") last = null;
      });
      for (const event of entry.state.poll(this.now())) last = event;
      if (last && !entry.state.headless) {
        const age = this.now() - last.at;
        if (last.waiting ? age <= BACKLOG_WAIT_MS : age <= BACKLOG_FINISH_MS) {
          await this._emitTurn(entry, last, { backlog: true });
        }
      }
      await yieldToEventLoop();
    }
  }

  _entry(file) {
    let entry = this.files.get(file);
    if (!entry) {
      entry = {
        file,
        chatId: path.basename(file, ".jsonl"),
        /** Byte offset of the next unread byte; null until the first read sets it. */
        offset: null,
        rest: Buffer.alloc(0),
        state: new TranscriptState(),
        mtimeMs: 0,
        reading: null,
        again: false,
        /** Answers seen; a turn answered while its record was looked up is not news. */
        answers: 0,
      };
      this.files.set(file, entry);
    }
    return entry;
  }

  _scheduleRead(file) {
    if (!this.running) return;
    clearTimeout(this.readTimers.get(file));
    const timer = setTimeout(() => {
      this.readTimers.delete(file);
      void this.readFile(file);
    }, READ_DEBOUNCE_MS);
    timer.unref?.();
    this.readTimers.set(file, timer);
  }

  /** Reads what was appended to one transcript now. The watch calls it after a write. */
  readFile(file) {
    const entry = this._entry(file);
    if (!this.running || entry.state.headless) return Promise.resolve();
    return this._read(entry, (event) => this._handle(entry, event));
  }

  /**
   * Reads what was appended since the last read. One read per file at a time;
   * a change during a read is picked up by a second pass right after it.
   */
  _read(entry, onEvent) {
    if (entry.reading) {
      entry.again = true;
      return entry.reading;
    }
    entry.reading = (async () => {
      do {
        entry.again = false;
        await this._readOnce(entry, onEvent);
      } while (entry.again && this.running);
    })()
      .catch((error) => {
        this.log("Narrator could not read a transcript", { error: error.message });
      })
      .finally(() => {
        entry.reading = null;
      });
    return entry.reading;
  }

  async _readOnce(entry, onEvent) {
    let stat;
    try {
      stat = await fsp.stat(entry.file);
    } catch {
      return;
    }
    entry.mtimeMs = stat.mtimeMs;
    let skipFirstLine = false;
    if (entry.offset === null || stat.size < entry.offset) {
      // First sight, or rewritten shorter: start from the tail. The tail
      // usually begins mid-line, and that piece is not a line.
      if (entry.offset !== null) entry.state = new TranscriptState();
      entry.offset = Math.max(0, stat.size - TAIL_BYTES);
      entry.rest = Buffer.alloc(0);
      skipFirstLine = entry.offset > 0;
    }
    while (entry.offset < stat.size && this.running) {
      const bytes = await readRange(entry.file, entry.offset, stat.size);
      if (bytes.length === 0) break;
      entry.offset += bytes.length;
      const { lines, rest } = splitLines(
        entry.rest.length ? Buffer.concat([entry.rest, bytes]) : bytes
      );
      entry.rest = rest;
      if (skipFirstLine) {
        lines.shift();
        skipFirstLine = false;
      }
      const now = this.now();
      for (const line of lines) {
        for (const event of entry.state.push(line, now)) onEvent(event);
        if (entry.state.headless) {
          // A `claude -p` run or the narrator's own rewriter: never news, never read again.
          entry.rest = Buffer.alloc(0);
          return;
        }
      }
      await yieldToEventLoop();
    }
  }

  async _poll() {
    if (!this.running) return;
    const now = this.now();
    for (const entry of this.files.values()) {
      if (entry.state.headless || entry.reading) continue;
      const pending = entry.state.endTurnAt !== null;
      if (!pending && now - entry.mtimeMs > ACTIVE_WINDOW_MS) continue;
      await this._read(entry, (event) => this._handle(entry, event));
      for (const event of entry.state.poll(this.now())) this._handle(entry, event);
    }
  }

  _handle(entry, event) {
    if (entry.state.headless || !this.running) return;
    if (event.type === "answered") {
      entry.answers += 1;
      this.onEvent({ kind: "answered", chatId: entry.chatId, at: event.at, source: "claude-code" });
      return;
    }
    if (event.type !== "turn-ended") return;
    if (this.now() - event.at > LIVE_MAX_AGE_MS) return;
    void this._emitTurn(entry, event, { backlog: false });
  }

  /**
   * Emits a turn once the desktop app's record for its chat is known. The
   * lookup can take a moment, and an answer read meanwhile, often from the
   * same read, goes out at once: a turn answered before it went out is dropped
   * rather than arriving after its own answer.
   */
  async _emitTurn(entry, event, { backlog }) {
    const answers = entry.answers;
    let record = null;
    try {
      record = (await this.sessionIndex?.lookup(entry.chatId)) || null;
    } catch {
      record = null;
    }
    if (record?.archived || !this.running || entry.answers !== answers) return;
    const cwd = record?.originCwd || entry.state.cwd || "";
    this.onEvent({
      kind: event.waiting ? "waiting" : "finished",
      chatId: entry.chatId,
      chatTitle: record?.title || entry.state.title || "",
      // The last folder of a Windows or POSIX path, whatever this OS calls a separator.
      project: cwd.split(/[\\/]/).filter(Boolean).pop() || "",
      recap: event.recap,
      ask: event.ask,
      at: event.at,
      backlog,
      openUrl: record ? desktopChatUrl(record.localId) : "",
      source: "claude-code",
    });
  }
}

module.exports = {
  ClaudeTranscriptSource,
  isTopLevelTranscript,
  splitLines,
  BACKLOG_WAIT_MS,
  BACKLOG_FINISH_MS,
  LIVE_MAX_AGE_MS,
};
