"use strict";

/**
 * Maps a Claude Code transcript to the Claude desktop app's own record of the
 * chat: its title as the sidebar shows it, its `local_` id (which opens the
 * chat from outside), its folder, when it was last active, and whether it is
 * archived.
 *
 * Checked on 2 Nov 2026: the app keeps one JSON file per chat at
 * <app data>/claude-code-sessions/<account>/<org>/local_<uuid>.json, holding
 * `sessionId` (the local_ id), `cliSessionId` (the transcript's file name),
 * `title`, `cwd`, `originCwd`, `lastActivityAt` and `isArchived`. Nothing here
 * writes to those files. A terminal chat has no record, and the narrator works
 * without one.
 *
 * About 500 records on a busy machine take over a second to read, so every
 * read is asynchronous and a record is read again only when its file changed.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const RESCAN_MIN_MS = 15_000;
const LOCAL_ID = /^local_[0-9a-f-]{36}$/i;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;

/** Every folder the desktop app may keep its chat records in on this machine. */
function defaultRoots() {
  if (process.env.PT_NARRATOR_DESKTOP_SESSIONS_DIR) {
    return [process.env.PT_NARRATOR_DESKTOP_SESSIONS_DIR];
  }
  const roots = [];
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  try {
    for (const entry of fs.readdirSync(path.join(local, "Claude-Data"), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        roots.push(path.join(local, "Claude-Data", entry.name, "claude-code-sessions"));
      }
    }
  } catch {
    // No desktop app data here.
  }
  roots.push(path.join(roaming, "Claude", "claude-code-sessions"));
  return roots;
}

async function listRecordFiles(root) {
  const files = [];
  const walk = async (dir, depth) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) await walk(full, depth + 1);
      else if (entry.isFile() && /^local_.*\.json$/i.test(entry.name)) files.push(full);
    }
  };
  await walk(root, 0);
  return files;
}

/** One record's fields the narrator uses, or null when the file is not a chat record. */
function parseRecord(text) {
  try {
    const data = JSON.parse(text);
    if (!data || typeof data.cliSessionId !== "string" || !LOCAL_ID.test(data.sessionId || "")) {
      return null;
    }
    return {
      cliSessionId: data.cliSessionId,
      localId: data.sessionId,
      title: typeof data.title === "string" ? data.title.trim().slice(0, 200) : "",
      cwd: typeof data.cwd === "string" ? data.cwd : "",
      originCwd: typeof data.originCwd === "string" ? data.originCwd : data.cwd || "",
      lastActivityAt: Number.isFinite(data.lastActivityAt) ? data.lastActivityAt : 0,
      archived: data.isArchived === true,
    };
  } catch {
    return null;
  }
}

class DesktopSessionIndex {
  constructor({ roots, now = () => Date.now() } = {}) {
    this.roots = roots || null;
    this.now = now;
    /** cliSessionId -> record */
    this.byCliId = new Map();
    /** file -> mtimeMs, so an unchanged record is not read twice */
    this.seen = new Map();
    this.lastScan = 0;
    this.scanning = null;
  }

  /** Reads every record that changed since the last scan. One scan at a time. */
  scan() {
    if (this.scanning) return this.scanning;
    this.lastScan = this.now();
    this.scanning = this._scan().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  async _scan() {
    for (const root of this.roots || defaultRoots()) {
      for (const file of await listRecordFiles(root)) {
        let stat;
        try {
          stat = await fsp.stat(file);
        } catch {
          continue;
        }
        if (stat.size > MAX_RECORD_BYTES || this.seen.get(file) === stat.mtimeMs) continue;
        this.seen.set(file, stat.mtimeMs);
        try {
          const record = parseRecord(await fsp.readFile(file, "utf8"));
          if (record) this.byCliId.set(record.cliSessionId, record);
        } catch {
          // Being rewritten by the app; the next scan reads it.
        }
      }
    }
  }

  /**
   * The app's record for a transcript id, or null. Rescans first when the last
   * scan is older than RESCAN_MIN_MS: a chat made since has no record yet, and
   * one renamed or archived since has an old one. A rescan reads only the
   * records that changed.
   */
  async lookup(cliSessionId) {
    if (!cliSessionId) return null;
    if (this.scanning) await this.scanning;
    if (this.now() - this.lastScan >= RESCAN_MIN_MS) await this.scan();
    return this.byCliId.get(cliSessionId) || null;
  }

  /** Chats active since `sinceMs` and not archived, newest first. */
  recent(sinceMs) {
    return Array.from(this.byCliId.values())
      .filter((record) => !record.archived && record.lastActivityAt >= sinceMs)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }
}

/** The address that opens a chat in the desktop app, or "" for an id that is not one. */
function desktopChatUrl(localId) {
  return LOCAL_ID.test(localId || "") ? `claude://claude.ai/epitaxy/${localId}` : "";
}

/**
 * Claude Code's folder name for a working directory under ~/.claude/projects:
 * every character that is not a letter or digit becomes "-". Checked against
 * all 17 chats active on this PC on 2 Nov 2026, worktree paths included.
 */
function projectFolderName(cwd) {
  return String(cwd || "").replace(/[^a-zA-Z0-9]/g, "-");
}

module.exports = {
  DesktopSessionIndex,
  desktopChatUrl,
  parseRecord,
  projectFolderName,
  LOCAL_ID,
};
