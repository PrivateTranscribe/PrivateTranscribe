/**
 * Remembers which `claude` session belongs to which project directory, so a
 * Converse session can be resumed after the app restarts.
 *
 * The CLI's `--resume <id>` needs an id the app can still produce tomorrow,
 * which means the id has to outlive the process that learned it. It is kept in
 * one small JSON file under Electron's userData directory:
 *
 *   { "<absolute project cwd>": { "sessionId": "<uuid>", "updatedAt": 1690… } }
 *
 * Keyed by cwd because that is what a resumed conversation is about — the same
 * repository, the same context — and because one machine can hold several
 * Converse projects at once.
 *
 * Writes go through a temp file plus rename, so a crash mid-write leaves the
 * previous mapping intact rather than a half-written file that reads as "no
 * session at all".
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STORE_FILE = "converse-sessions.json";

/**
 * Where the mapping lives.
 *
 * An explicit path wins (tests, and any future per-profile split), then the
 * PT_CONVERSE_SESSION_STORE override, and otherwise Electron's userData — which
 * is per-profile, so an e2e run with its own `--user-data-dir` can never read or
 * write the developer's real mapping.
 */
function resolveStorePath(explicitPath) {
  if (explicitPath) return explicitPath;
  if (process.env.PT_CONVERSE_SESSION_STORE) return process.env.PT_CONVERSE_SESSION_STORE;
  try {
    const { app } = require("electron");
    if (app && typeof app.getPath === "function") {
      return path.join(app.getPath("userData"), STORE_FILE);
    }
  } catch {
    // Not running inside Electron (unit tests, scripts).
  }
  return path.join(os.tmpdir(), STORE_FILE);
}

/** Same directory spelled two ways must be the same key. */
function normalizeKey(cwd) {
  const resolved = path.resolve(String(cwd || ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** The whole mapping. A missing or corrupt file reads as empty, never throws. */
function readStore(explicitPath) {
  const file = resolveStorePath(explicitPath);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The remembered session id for `cwd`, or null. */
function readSessionId(cwd, explicitPath) {
  const entry = readStore(explicitPath)[normalizeKey(cwd)];
  const id = entry && typeof entry.sessionId === "string" ? entry.sessionId.trim() : "";
  return id || null;
}

/**
 * Record `sessionId` for `cwd`. Returns false if nothing was written (no id, or
 * the write failed) — remembering a session is best-effort and must never take
 * a live conversation down with it.
 */
function writeSessionId(cwd, sessionId, explicitPath) {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!id) return false;

  const file = resolveStorePath(explicitPath);
  const store = readStore(file);
  store[normalizeKey(cwd)] = { sessionId: id, updatedAt: Date.now() };

  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Nothing else to do; the previous mapping is still on disk.
    }
    return false;
  }
}

module.exports = {
  STORE_FILE,
  resolveStorePath,
  readStore,
  readSessionId,
  writeSessionId,
};
