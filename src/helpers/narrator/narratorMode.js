"use strict";

/**
 * Narrator mode, per chat. A chat turns it on by loading a skill named
 * `narrator`, or one whose name ends in `-narrator`, and off by loading that
 * skill again with the argument `off`. The latest load wins. Both ways to load
 * a skill count:
 *
 *   assistant  tool_use Skill {"skill": "x-narrator"}                 on
 *   assistant  tool_use Skill {"skill": "x-narrator", "args": "off"}  off
 *   user       <command-name>/x-narrator</command-name> … <command-args>off</command-args>
 *
 * A load can sit anywhere in a transcript of hundreds of megabytes, far before
 * the tail the transcript source reads. So each file is scanned once from its
 * start and after that only as it grows, and the scan parses only the lines
 * that hold one of two byte markers. It only reads.
 */

const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const SKILL_MARKER = Buffer.from('"name":"Skill"');
const COMMAND_MARKER = Buffer.from("<command-name>/");
const NEWLINE = 0x0a;
/** Read per step; a line longer than this is carried into the next step whole. */
const CHUNK_BYTES = 4 * 1024 * 1024;
/** Claude Code session ids are UUIDs; anything else never names a file. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function defaultRoot() {
  return process.env.PT_NARRATOR_CLAUDE_DIR || path.join(os.homedir(), ".claude", "projects");
}

/** Whether a skill or slash command name is a narrator skill, with or without a plugin prefix. */
function isNarratorSkill(name) {
  if (typeof name !== "string") return false;
  const bare = name.trim().replace(/^\//, "").split(":").pop().toLowerCase();
  return bare === "narrator" || bare.endsWith("-narrator");
}

function isOff(args) {
  return typeof args === "string" && args.trim().toLowerCase() === "off";
}

function commandText(record) {
  const content = record.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * What one transcript record does to narrator mode: true turns it on, false
 * off, null leaves it as it was. A subagent's line never counts.
 */
function narratorChange(record) {
  if (!record || typeof record !== "object" || record.isSidechain) return null;
  let change = null;
  if (record.type === "assistant" && Array.isArray(record.message?.content)) {
    for (const block of record.message.content) {
      if (block?.type !== "tool_use" || block.name !== "Skill") continue;
      if (isNarratorSkill(block.input?.skill)) change = !isOff(block.input?.args);
    }
  } else if (record.type === "user") {
    const text = commandText(record);
    const name = /<command-name>\/?([^<]*)<\/command-name>/.exec(text)?.[1];
    if (isNarratorSkill(name)) {
      change = !isOff(/<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]);
    }
  }
  return change;
}

/** Where every marker in `bytes` starts, in file order. */
function markerHits(bytes, end) {
  const hits = [];
  for (const marker of [SKILL_MARKER, COMMAND_MARKER]) {
    for (let at = bytes.indexOf(marker); at >= 0 && at < end; at = bytes.indexOf(marker, at + 1)) {
      hits.push(at);
    }
  }
  return hits.sort((a, b) => a - b);
}

/**
 * Scans bytes [from, to) of a file for narrator changes. Resolves with the
 * last change seen (or `mode` when none) and the offset of the first byte of
 * an unfinished last line, where the next scan starts.
 */
async function scanFile(file, from, to, mode) {
  const handle = await fsp.open(file, "r");
  try {
    let offset = from;
    let carry = Buffer.alloc(0);
    while (offset < to) {
      const length = Math.min(CHUNK_BYTES, to - offset);
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      const bytes = carry.length
        ? Buffer.concat([carry, chunk.subarray(0, bytesRead)])
        : chunk.subarray(0, bytesRead);
      const lastNewline = bytes.lastIndexOf(NEWLINE);
      const complete = lastNewline + 1;
      let parsedTo = 0;
      for (const hit of markerHits(bytes, complete)) {
        if (hit < parsedTo) continue;
        const start = bytes.lastIndexOf(NEWLINE, hit) + 1;
        const end = bytes.indexOf(NEWLINE, hit);
        parsedTo = end + 1;
        let record = null;
        try {
          record = JSON.parse(bytes.toString("utf8", start, end));
        } catch {
          continue;
        }
        const change = narratorChange(record);
        if (change !== null) mode = change;
      }
      carry = bytes.subarray(complete);
    }
    return { mode, scannedTo: offset - carry.length };
  } finally {
    await handle.close();
  }
}

class NarratorModes {
  constructor({ root = defaultRoot(), log = () => {} } = {}) {
    this.root = root;
    this.log = log;
    /** file -> {mode, scannedTo, pending} */
    this.files = new Map();
    /** session id -> its transcript file, once found */
    this.sessions = new Map();
  }

  /** Whether the chat whose transcript this is has narrator mode on now. */
  async modeOf(file) {
    let entry = this.files.get(file);
    if (!entry) {
      entry = { mode: false, scannedTo: 0, pending: null };
      this.files.set(file, entry);
    }
    // One scan per file at a time; a caller during a scan waits for it, then scans what came after.
    while (entry.pending) await entry.pending;
    entry.pending = (async () => {
      try {
        const { size } = await fsp.stat(file);
        if (size < entry.scannedTo) Object.assign(entry, { mode: false, scannedTo: 0 });
        if (size > entry.scannedTo) {
          Object.assign(entry, await scanFile(file, entry.scannedTo, size, entry.mode));
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
          this.log("Narrator could not read a chat's narrator mode", { error: error.message });
        }
      }
    })();
    try {
      await entry.pending;
    } finally {
      entry.pending = null;
    }
    return entry.mode;
  }

  /**
   * Narrator mode of a Claude Code session by its id: true or false, or null
   * when its transcript cannot be found. `cwd`, when known, names its project
   * folder; otherwise every project folder is looked in once.
   */
  async modeOfSession(sessionId, { cwd = "" } = {}) {
    const file = await this.findSession(sessionId, cwd);
    return file ? this.modeOf(file) : null;
  }

  async findSession(sessionId, cwd = "") {
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return null;
    const known = this.sessions.get(sessionId);
    if (known) return known;
    const name = `${sessionId}.jsonl`;
    const folders = [];
    if (cwd) folders.push(String(cwd).replace(/[^a-zA-Z0-9]/g, "-"));
    try {
      folders.push(...(await fsp.readdir(this.root)));
    } catch {
      // No transcripts on this machine.
    }
    for (const folder of folders) {
      const file = path.join(this.root, folder, name);
      try {
        await fsp.access(file);
        this.sessions.set(sessionId, file);
        if (this.sessions.size > 200) this.sessions.delete(this.sessions.keys().next().value);
        return file;
      } catch {
        // Not in this folder.
      }
    }
    return null;
  }

  forget(file) {
    this.files.delete(file);
  }

  clear() {
    this.files.clear();
    this.sessions.clear();
  }
}

module.exports = { NarratorModes, narratorChange, isNarratorSkill, scanFile, SESSION_ID };
