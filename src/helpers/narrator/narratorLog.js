"use strict";

/**
 * A local record of what the narrator said and showed, for counting a week of
 * use. One JSON object per line in the app's user-data folder. Nothing in it
 * leaves the machine; there is no telemetry.
 *
 * The file is read once, the first time a count is asked for; after that the
 * counts come from memory, because the page asks on every state change.
 */

const fs = require("node:fs");
const path = require("node:path");

const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** Entries kept in memory for counting: the week the page shows. */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

class NarratorLog {
  constructor(file, { now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    /** {at, kind} of the last week, oldest first; null until the file was read */
    this.recent = null;
  }

  /**
   * A voice question is written with its `id` and `chars` (how long it was)
   * and without `text`, `chatId` or `chatTitle`.
   *
   * @param {{kind: string, result?: string, id?: string, chars?: number, chatId?: string, chatTitle?: string, text?: string, language?: string, latencyMs?: number|null}} entry
   */
  append(entry) {
    const at = this.now();
    this._entries().push({ at, kind: entry.kind });
    this._prune(at);
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      try {
        if (fs.statSync(this.file).size > MAX_LOG_BYTES) {
          fs.renameSync(this.file, `${this.file}.1`);
        }
      } catch {
        // No log yet.
      }
      fs.appendFileSync(
        this.file,
        `${JSON.stringify({ at: new Date(at).toISOString(), ...entry })}\n`
      );
    } catch {
      // A log that cannot be written never stops the narrator.
    }
  }

  /** Counts per kind since `sinceMs`. */
  countSince(sinceMs) {
    const counts = {};
    for (const entry of this._entries()) {
      if (entry.at >= sinceMs) counts[entry.kind] = (counts[entry.kind] || 0) + 1;
    }
    return counts;
  }

  _entries() {
    if (this.recent) return this.recent;
    this.recent = [];
    // The rotated file first, so the entries stay oldest first.
    for (const file of this.file ? [`${this.file}.1`, this.file] : []) {
      let text = "";
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          const at = Date.parse(entry.at);
          if (Number.isFinite(at) && typeof entry.kind === "string") {
            this.recent.push({ at, kind: entry.kind });
          }
        } catch {
          // A torn line from a crash is skipped.
        }
      }
    }
    this._prune(this.now());
    return this.recent;
  }

  _prune(now) {
    const cutoff = now - KEEP_MS;
    if (this.recent.length > 0 && this.recent[0].at < cutoff) {
      this.recent = this.recent.filter((entry) => entry.at >= cutoff);
    }
  }
}

module.exports = { NarratorLog };
