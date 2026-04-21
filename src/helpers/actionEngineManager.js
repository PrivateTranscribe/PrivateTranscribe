"use strict";

/**
 * Action Engine Manager - main-process module.
 *
 * Responsibilities:
 *   1. CRUD for user-defined actions (backed by the shared SQLite database).
 *   2. Pure pattern matching: given a transcript, return matching actions.
 *   3. Safe action execution: shell, url, app, dictation-mode.
 *
 * Pure functions (matchesTrigger, findMatches, validateActionPayload,
 * tokenizeCommand) are exported separately so they can be unit-tested without
 * any Electron or filesystem dependencies.
 *
 * @module helpers/actionEngineManager
 */

const { shell } = require("electron");
const { execFile } = require("child_process");
const { promisify } = require("util");
const crypto = require("crypto");

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum wall-clock time (ms) allowed for a shell action subprocess. */
const SHELL_TIMEOUT_MS = 10_000;

/**
 * Maximum number of characters fed to a regex trigger match.
 * Transcripts are conversational speech — capping at 2 000 chars is far above
 * any real trigger phrase while bounding the worst-case backtracking cost for
 * a poorly-written pattern.
 */
const REGEX_MATCH_INPUT_LIMIT = 2_000;

/**
 * Guard against the most common catastrophic-backtracking constructs.
 * Matches patterns that nest a quantifier inside a group that itself carries
 * a quantifier — e.g. (a+)+, (a*b*)*, (x|y+)+.
 * This is a conservative heuristic: it rejects some harmless patterns but
 * never allows a known-dangerous one through.
 */
const REDOS_PATTERN = /\([^)]*[+*][^)]*\)[+*?]/;

const VALID_TRIGGER_MODES = new Set(["exact", "prefix", "contains", "regex"]);
const VALID_ACTION_TYPES = new Set(["shell", "url", "app", "dictation-mode"]);
const UNSAFE_EXECUTABLE_CHARS = /[|&;<>`$]/;

// ─────────────────────────────────────────────────────────────────────────────
// Pure pattern-matching helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a speech-transcription string or trigger phrase for fuzzy matching.
 *
 * Speech-to-text engines routinely insert punctuation that the speaker did not
 * intend as part of a command (e.g. "Open, NordicFuture" for "Open NordicFuture").
 * This function strips those artifact characters so that trigger-phrase matching
 * is not broken by transcription noise.
 *
 * Rules applied (in order):
 *   1. Trim leading/trailing whitespace.
 *   2. Remove common STT punctuation artifacts: , . ! ? ; :
 *      These are stripped (not replaced) because they carry no semantic meaning
 *      in voice-command phrases and are the characters most frequently inserted
 *      by transcription engines between words.
 *   3. Collapse runs of whitespace to a single space (handles gaps left after
 *      punctuation removal).
 *   4. Re-trim (a leading punctuation strip can leave a leading space).
 *   5. Lowercase.
 *
 * Characters deliberately NOT stripped:
 *   - Apostrophes  (') - preserve contractions such as "don't", "can't".
 *   - Hyphens      (-) - preserve compound phrases such as "push-to-talk".
 *   - All other characters - conservative; avoids surprising behaviour.
 *
 * This function is NOT applied for `regex` mode - the user's pattern governs
 * matching in full.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeForMatching(text) {
  return text
    .trim()
    .replace(/[,.!?;:]/g, "") // strip common STT punctuation artifacts
    .replace(/\s+/g, " ") // collapse runs of whitespace
    .trim() // re-trim (leading punctuation may leave a leading space)
    .toLowerCase();
}

/**
 * Returns true if `transcript` satisfies the trigger condition for `action`.
 * Comparison is always case-insensitive and punctuation-normalized for
 * non-regex modes so that STT artifacts (e.g. stray commas) do not prevent
 * an expected trigger phrase from firing.
 *
 * @param {string} transcript
 * @param {import('../types/actionEngine').Action} action
 * @returns {boolean}
 */
function matchesTrigger(transcript, action) {
  if (!action.enabled) return false;

  if (action.triggerMode === "regex") {
    // Regex mode: the caller controls the pattern in full - no normalization.
    // Cap input length to bound worst-case backtracking for any stored pattern.
    try {
      const input = (typeof transcript === "string" ? transcript.trim() : "").slice(
        0,
        REGEX_MATCH_INPUT_LIMIT
      );
      return new RegExp(action.triggerPhrase, "i").test(input);
    } catch {
      // Malformed stored regex - treat as no match rather than crashing.
      return false;
    }
  }

  const hay = typeof transcript === "string" ? normalizeForMatching(transcript) : "";
  const needle =
    typeof action.triggerPhrase === "string" ? normalizeForMatching(action.triggerPhrase) : "";

  if (!needle) return false;

  switch (action.triggerMode) {
    case "exact":
      return hay === needle;

    case "prefix":
      return hay.startsWith(needle);

    case "contains":
      return hay.includes(needle);

    default:
      return false;
  }
}

/**
 * Return all actions from `actions` whose trigger matches `transcript`.
 * Order is preserved (caller decides priority ordering).
 *
 * @param {string} transcript
 * @param {import('../types/actionEngine').Action[]} actions
 * @returns {import('../types/actionEngine').ActionMatchResult[]}
 */
function findMatches(transcript, actions) {
  return actions
    .filter((a) => matchesTrigger(transcript, a))
    .map((a) => ({ action: a, matchedText: transcript }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Input validation (pure - no side effects)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate and normalise a raw action payload before saving to the database.
 * Throws a descriptive Error if any field is invalid.
 *
 * @param {unknown} raw
 * @returns {{
 *   name: string,
 *   description: string,
 *   triggerPhrase: string,
 *   triggerMode: import('../types/actionEngine').TriggerMode,
 *   actionType: import('../types/actionEngine').ActionType,
 *   actionConfig: import('../types/actionEngine').ActionConfig,
 *   enabled: boolean
 * }}
 */
function validateActionPayload(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Action payload must be a plain object.");
  }
  const r = /** @type {Record<string, unknown>} */ (raw);

  // ── name ──
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) throw new Error("Action name is required.");
  if (name.length > 100) throw new Error("Action name must be 100 characters or fewer.");

  // ── description ──
  const description = typeof r.description === "string" ? r.description.trim() : "";

  // ── triggerPhrase ──
  const triggerPhrase = typeof r.triggerPhrase === "string" ? r.triggerPhrase.trim() : "";
  if (!triggerPhrase) throw new Error("Trigger phrase is required.");
  if (triggerPhrase.length > 500)
    throw new Error("Trigger phrase must be 500 characters or fewer.");

  // ── triggerMode ──
  const triggerMode = typeof r.triggerMode === "string" ? r.triggerMode : "contains";
  if (!VALID_TRIGGER_MODES.has(triggerMode)) {
    throw new Error(
      `Invalid trigger mode "${triggerMode}". Must be one of: ${[...VALID_TRIGGER_MODES].join(", ")}.`
    );
  }

  // Validate regex at save time: must compile and must not use constructs that
  // are known to cause catastrophic backtracking (nested quantifiers).
  if (triggerMode === "regex") {
    try {
      new RegExp(triggerPhrase, "i");
    } catch {
      throw new Error("Trigger phrase is not a valid regular expression.");
    }
    if (REDOS_PATTERN.test(triggerPhrase)) {
      throw new Error(
        "Trigger phrase contains unsafe regex constructs (nested quantifiers). " +
          "Simplify the pattern to avoid catastrophic backtracking."
      );
    }
  }

  // ── actionType ──
  const actionType = typeof r.actionType === "string" ? r.actionType : "";
  if (!VALID_ACTION_TYPES.has(actionType)) {
    throw new Error(
      `Invalid action type "${actionType}". Must be one of: ${[...VALID_ACTION_TYPES].join(", ")}.`
    );
  }

  // ── actionConfig ──
  const rawConfig =
    r.actionConfig && typeof r.actionConfig === "object" && !Array.isArray(r.actionConfig)
      ? /** @type {Record<string, unknown>} */ (r.actionConfig)
      : {};

  validateActionConfig(actionType, rawConfig);

  const actionConfig = /** @type {import('../types/actionEngine').ActionConfig} */ (rawConfig);

  // ── enabled ──
  const enabled = r.enabled !== false;

  return { name, description, triggerPhrase, triggerMode, actionType, actionConfig, enabled };
}

/**
 * Validate the config object for a specific action type.
 * Throws with a human-readable message on failure.
 *
 * @param {string} actionType
 * @param {Record<string, unknown>} config
 */
function validateActionConfig(actionType, config) {
  switch (actionType) {
    case "shell": {
      const cmd = typeof config.command === "string" ? config.command.trim() : "";
      if (!cmd) throw new Error("Shell action requires a non-empty command.");
      if (cmd.length > 1_000) throw new Error("Shell command must be 1 000 characters or fewer.");
      const parts = tokenizeCommand(cmd);
      if (parts.length === 0) throw new Error("Shell action requires a valid executable.");
      const executable = parts[0];
      if (!isSafeShellExecutable(executable)) {
        throw new Error("Shell executable contains unsupported characters.");
      }
      break;
    }

    case "url": {
      let url = typeof config.url === "string" ? config.url.trim() : "";
      if (!url) throw new Error("URL action requires a non-empty URL.");

      // Auto-normalize: if the user omitted the protocol entirely, prepend https://.
      // Only do this when no "://" is present at all (e.g. "example.com").
      // If a different scheme is present (e.g. "ftp://"), reject with a clear message.
      if (!url.includes("://")) {
        url = "https://" + url;
        config.url = url;
      }

      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`"${url}" is not a valid URL. Example: https://example.com`);
      }
      if (!["https:", "http:"].includes(parsed.protocol)) {
        throw new Error(
          `Only https:// and http:// URLs are supported (got "${parsed.protocol.replace(":", "")}://"). ` +
            `Update the URL to start with https://`
        );
      }
      break;
    }

    case "app": {
      const appPath = typeof config.appPath === "string" ? config.appPath.trim() : "";
      if (!appPath) throw new Error("App action requires a non-empty appPath.");
      break;
    }

    case "dictation-mode": {
      const mode = typeof config.mode === "string" ? config.mode.trim() : "";
      if (!mode) throw new Error("Dictation-mode action requires a non-empty mode.");
      break;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shell command tokenizer (pure)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split a command string into an executable + argument list.
 * Respects single and double quoting; does NOT support escapes or variable
 * expansion (we use execFile, not a shell, so shell expansion is intentionally
 * absent for security).
 *
 * @param {string} command
 * @returns {string[]}
 */
function tokenizeCommand(command) {
  const tokens = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (const ch of command) {
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === " " && !inSingle && !inDouble) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }

  if (current.length > 0) tokens.push(current);
  return tokens;
}

function isSafeShellExecutable(executable) {
  if (typeof executable !== "string" || executable.trim() === "") return false;
  if (/[\r\n\0]/.test(executable)) return false;
  if (UNSAFE_EXECUTABLE_CHARS.test(executable)) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Action execution (side-effecting - runs in main process only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a single action and return a result.
 *
 * @param {import('../types/actionEngine').Action} action
 * @param {{ windowManager?: any }} [context]
 * @returns {Promise<import('../types/actionEngine').ActionExecuteResult>}
 */
async function executeAction(action, context = {}) {
  try {
    switch (action.actionType) {
      case "shell":
        return await _executeShell(action.actionConfig);
      case "url":
        return await _executeUrl(action.actionConfig);
      case "app":
        return await _executeApp(action.actionConfig);
      case "dictation-mode":
        return _executeDictationMode(action.actionConfig, context);
      default:
        return { success: false, error: `Unknown action type: ${action.actionType}` };
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * @param {import('../types/actionEngine').ActionConfig} config
 * @returns {Promise<import('../types/actionEngine').ActionExecuteResult>}
 */
async function _executeShell(config) {
  const command = typeof config.command === "string" ? config.command.trim() : "";
  if (!command) return { success: false, error: "No command specified." };

  const parts = tokenizeCommand(command);
  if (parts.length === 0) return { success: false, error: "Empty command." };

  const [executable, ...args] = parts;
  if (!isSafeShellExecutable(executable)) {
    return { success: false, error: "Executable contains unsupported characters." };
  }
  const { stdout, stderr } = await execFileAsync(executable, args, {
    timeout: SHELL_TIMEOUT_MS,
    windowsHide: true,
  });

  const output = (stdout || "").trim() || (stderr || "").trim();
  return { success: true, output: output || undefined };
}

/**
 * @param {import('../types/actionEngine').ActionConfig} config
 * @returns {Promise<import('../types/actionEngine').ActionExecuteResult>}
 */
async function _executeUrl(config) {
  const url = typeof config.url === "string" ? config.url.trim() : "";
  if (!url) return { success: false, error: "No URL specified." };
  await shell.openExternal(url);
  return { success: true };
}

/**
 * @param {import('../types/actionEngine').ActionConfig} config
 * @returns {Promise<import('../types/actionEngine').ActionExecuteResult>}
 */
async function _executeApp(config) {
  const appPath = typeof config.appPath === "string" ? config.appPath.trim() : "";
  if (!appPath) return { success: false, error: "No app path specified." };
  const errorMessage = await shell.openPath(appPath);
  if (errorMessage) return { success: false, error: errorMessage };
  return { success: true };
}

/**
 * @param {import('../types/actionEngine').ActionConfig} config
 * @param {{ windowManager?: any }} context
 * @returns {import('../types/actionEngine').ActionExecuteResult}
 */
function _executeDictationMode(config, context) {
  const mode = typeof config.mode === "string" ? config.mode.trim() : "";
  if (!mode) return { success: false, error: "No mode specified." };

  const wins = [
    context.windowManager?.mainWindow,
    context.windowManager?.controlPanelWindow,
  ].filter((w) => w && !w.isDestroyed());

  for (const win of wins) {
    win.webContents.send("action-engine-dictation-mode", mode);
  }

  return { success: true, output: mode };
}

// ─────────────────────────────────────────────────────────────────────────────
// Run history pruning (pure - exported for unit tests)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Delete the oldest action runs so that at most `maxRuns` rows remain.
 * A `maxRuns` value of 0 (or any non-positive number) means "unlimited" and
 * returns 0 immediately without touching the database.
 *
 * This is a pure-ish function (takes the db handle as a parameter) so it can
 * be unit-tested against an in-memory mock without constructing a full
 * ActionEngineManager instance.
 *
 * @param {{ prepare: (sql: string) => { run: (...args: unknown[]) => { changes: number } } }} db
 *   A better-sqlite3 Database handle (or a compatible mock).
 * @param {number} maxRuns
 *   Maximum number of runs to retain.  0 = unlimited.
 * @returns {number} Number of rows deleted.
 */
function pruneRunsToLimit(db, maxRuns) {
  const safeMax = Math.round(Number(maxRuns) || 0);
  if (safeMax <= 0) return 0; // 0 or negative → unlimited, nothing to prune

  const result = db
    .prepare(
      `DELETE FROM action_runs
       WHERE id NOT IN (
         SELECT id FROM action_runs ORDER BY triggered_at DESC LIMIT ?
       )`
    )
    .run(safeMax);
  return result.changes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Run record builder (pure - exported for unit tests)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a run record object ready to be inserted into `action_runs`.
 * This is a pure function so it can be tested without any database or Electron
 * dependency.
 *
 * @param {import('../types/actionEngine').Action} action - The action that was executed.
 * @param {import('../types/actionEngine').ActionExecuteResult} result - Execution outcome.
 * @param {'manual' | 'transcript'} triggeredBy - How the run was initiated.
 * @param {string | null} triggerText - Transcript text for 'transcript' runs, null otherwise.
 * @param {number} durationMs - Wall-clock execution time in milliseconds.
 * @returns {{
 *   id: string,
 *   actionId: string,
 *   actionName: string,
 *   actionType: string,
 *   triggerText: string | null,
 *   triggeredBy: string,
 *   success: boolean,
 *   output: string | null,
 *   error: string | null,
 *   durationMs: number,
 *   triggeredAt: string,
 * }}
 */
function buildRunRecord(action, result, triggeredBy, triggerText, durationMs) {
  return {
    id: crypto.randomUUID(),
    actionId: action.id,
    actionName: action.name,
    actionType: action.actionType,
    triggerText: triggerText ?? null,
    triggeredBy: triggeredBy === "transcript" ? "transcript" : "manual",
    success: result.success,
    output: typeof result.output === "string" ? result.output : null,
    error: typeof result.error === "string" ? result.error : null,
    durationMs: Math.round(Math.max(0, durationMs)),
    triggeredAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Database row ↔ Action conversion helpers (pure)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Record<string, unknown>} row
 * @returns {import('../types/actionEngine').Action}
 */
function _rowToAction(row) {
  let actionConfig = {};
  try {
    actionConfig = JSON.parse(String(row.action_config || "{}"));
  } catch {
    // Corrupted stored JSON - fall back to empty config.
  }
  return {
    id: String(row.id),
    name: String(row.name || ""),
    description: String(row.description || ""),
    triggerPhrase: String(row.trigger_phrase || ""),
    triggerMode: /** @type {import('../types/actionEngine').TriggerMode} */ (
      String(row.trigger_mode || "contains")
    ),
    actionType: /** @type {import('../types/actionEngine').ActionType} */ (
      String(row.action_type || "")
    ),
    actionConfig,
    enabled: row.enabled !== 0,
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

/**
 * Convert a raw `action_runs` database row to an ActionRun object.
 *
 * @param {Record<string, unknown>} row
 * @returns {import('../types/actionEngine').ActionRun}
 */
function _rowToRun(row) {
  return {
    id: String(row.id),
    actionId: String(row.action_id),
    actionName: String(row.action_name || ""),
    actionType: String(row.action_type || ""),
    triggerText: row.trigger_text != null ? String(row.trigger_text) : null,
    triggeredBy: /** @type {'manual' | 'transcript'} */ (String(row.triggered_by || "manual")),
    success: row.success !== 0,
    output: row.output != null ? String(row.output) : undefined,
    error: row.error != null ? String(row.error) : undefined,
    durationMs: Number(row.duration_ms) || 0,
    triggeredAt: String(row.triggered_at || ""),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ActionEngineManager class
// ─────────────────────────────────────────────────────────────────────────────

class ActionEngineManager {
  /**
   * @param {import('./database')} databaseManager
   *   The shared DatabaseManager instance.  We access `databaseManager.db`
   *   (the raw better-sqlite3 handle) directly for synchronous queries.
   */
  constructor(databaseManager) {
    /** @type {import('better-sqlite3').Database} */
    this.db = databaseManager.db;

    /**
     * Per-action debounce map for transcript-triggered executions.
     * Maps action id → timestamp (ms) of the last transcript-triggered run.
     * Prevents the same voice command from firing twice in rapid succession
     * when streaming transcription produces overlapping final segments.
     *
     * Only applies when triggeredBy === 'transcript'.
     * Manual "Test" runs always bypass this guard.
     *
     * Override via env: PRIVOCA_ACTION_DEBOUNCE_MS (default 2000).
     */
    this._lastTranscriptRunMs = new Map();
    this._transcriptDebounceMs = (() => {
      const v = parseInt(process.env.PRIVOCA_ACTION_DEBOUNCE_MS ?? "", 10);
      return Number.isFinite(v) && v >= 0 ? v : 2000;
    })();
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /**
   * Return all actions ordered by creation time (oldest first).
   * @returns {import('../types/actionEngine').Action[]}
   */
  listActions() {
    const rows = this.db.prepare("SELECT * FROM actions ORDER BY created_at ASC").all();
    return rows.map(_rowToAction);
  }

  /**
   * Return a single action by its UUID, or null if not found.
   * @param {string} id
   * @returns {import('../types/actionEngine').Action | null}
   */
  getAction(id) {
    const row = this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id);
    return row ? _rowToAction(row) : null;
  }

  /**
   * Create a new action, returning the persisted record.
   * Throws if the payload is invalid.
   *
   * @param {unknown} payload
   * @returns {import('../types/actionEngine').Action}
   */
  createAction(payload) {
    const validated = validateActionPayload(payload);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO actions
           (id, name, description, trigger_phrase, trigger_mode,
            action_type, action_config, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        validated.name,
        validated.description,
        validated.triggerPhrase,
        validated.triggerMode,
        validated.actionType,
        JSON.stringify(validated.actionConfig),
        validated.enabled ? 1 : 0,
        now,
        now
      );

    return /** @type {import('../types/actionEngine').Action} */ (this.getAction(id));
  }

  /**
   * Update an existing action (partial update - unspecified fields are kept).
   * Throws if the action is not found or the merged payload is invalid.
   *
   * @param {string} id
   * @param {unknown} patch
   * @returns {import('../types/actionEngine').Action}
   */
  updateAction(id, patch) {
    const existing = this.getAction(id);
    if (!existing) throw new Error(`Action not found: ${id}`);

    // Merge patch over existing values, then re-validate the whole payload.
    const merged = { ...existing, ...(patch || {}), id };
    const validated = validateActionPayload(merged);
    const now = new Date().toISOString();

    this.db
      .prepare(
        `UPDATE actions
         SET name = ?, description = ?, trigger_phrase = ?, trigger_mode = ?,
             action_type = ?, action_config = ?, enabled = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        validated.name,
        validated.description,
        validated.triggerPhrase,
        validated.triggerMode,
        validated.actionType,
        JSON.stringify(validated.actionConfig),
        validated.enabled ? 1 : 0,
        now,
        id
      );

    return /** @type {import('../types/actionEngine').Action} */ (this.getAction(id));
  }

  /**
   * Permanently delete an action.
   * @param {string} id
   * @returns {{ success: boolean }}
   */
  deleteAction(id) {
    const result = this.db.prepare("DELETE FROM actions WHERE id = ?").run(id);
    return { success: result.changes > 0 };
  }

  /**
   * Enable or disable an action without touching other fields.
   * @param {string} id
   * @param {boolean} enabled
   * @returns {import('../types/actionEngine').Action}
   */
  setActionEnabled(id, enabled) {
    const existing = this.getAction(id);
    if (!existing) throw new Error(`Action not found: ${id}`);

    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE actions SET enabled = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, now, id);

    return /** @type {import('../types/actionEngine').Action} */ (this.getAction(id));
  }

  // ── Matching ──────────────────────────────────────────────────────────────

  /**
   * Find all enabled actions that match `transcript`.
   * @param {string} transcript
   * @returns {import('../types/actionEngine').ActionMatchResult[]}
   */
  matchTranscript(transcript) {
    const enabledActions = this.listActions().filter((a) => a.enabled);
    return findMatches(transcript, enabledActions);
  }

  // ── Execution ─────────────────────────────────────────────────────────────

  /**
   * Execute an action by its ID and record the outcome in `action_runs`.
   * Returns a failure result (does not throw) if the action is not found or disabled.
   *
   * @param {string} id
   * @param {{ windowManager?: any }} [context]
   * @param {{ triggeredBy?: 'manual' | 'transcript', triggerText?: string | null }} [runOptions]
   * @returns {Promise<import('../types/actionEngine').ActionExecuteResult>}
   */
  async executeById(id, context = {}, runOptions = {}) {
    const action = this.getAction(id);
    if (!action) return { success: false, error: `Action not found: ${id}` };
    if (!action.enabled) return { success: false, error: "Action is disabled." };

    const triggeredBy = runOptions.triggeredBy === "transcript" ? "transcript" : "manual";
    const triggerText = runOptions.triggerText ?? null;

    // ── Transcript debounce ─────────────────────────────────────────────────
    // When an action is triggered by transcript matching, enforce a per-action
    // cooldown to prevent duplicate executions caused by streaming transcription
    // overlaps or accidental repeated utterances.  Manual "Test" runs bypass
    // this guard so users always get immediate feedback from the UI.
    if (triggeredBy === "transcript" && this._transcriptDebounceMs > 0) {
      const lastRun = this._lastTranscriptRunMs.get(id) ?? 0;
      const elapsed = Date.now() - lastRun;
      if (elapsed < this._transcriptDebounceMs) {
        return {
          success: false,
          debounced: true,
          error: `Action debounced — last ran ${elapsed}ms ago (cooldown: ${this._transcriptDebounceMs}ms)`,
        };
      }
      this._lastTranscriptRunMs.set(id, Date.now());
    }
    // ───────────────────────────────────────────────────────────────────────

    const startMs = Date.now();
    const result = await executeAction(action, context);
    const durationMs = Date.now() - startMs;

    // Persist the run record. Errors here must never surface to the caller -
    // observability must not break functionality.
    try {
      const run = buildRunRecord(action, result, triggeredBy, triggerText, durationMs);
      this.db
        .prepare(
          `INSERT INTO action_runs
             (id, action_id, action_name, action_type, trigger_text,
              triggered_by, success, output, error, duration_ms, triggered_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          run.id,
          run.actionId,
          run.actionName,
          run.actionType,
          run.triggerText,
          run.triggeredBy,
          run.success ? 1 : 0,
          run.output ?? null,
          run.error ?? null,
          run.durationMs,
          run.triggeredAt
        );
    } catch (dbErr) {
      console.error("[ActionEngine] Failed to record run:", dbErr?.message ?? dbErr);
    }

    return result;
  }

  // ── Run History ───────────────────────────────────────────────────────────

  /**
   * Return recent action runs, newest first.
   *
   * @param {number} [limit=50] - Maximum number of records to return.
   * @returns {import('../types/actionEngine').ActionRun[]}
   */
  listRuns(limit = 50) {
    const safeLimit = Math.max(1, Math.min(500, Math.round(Number(limit) || 50)));
    const rows = this.db
      .prepare("SELECT * FROM action_runs ORDER BY triggered_at DESC LIMIT ?")
      .all(safeLimit);
    return rows.map(_rowToRun);
  }

  /**
   * Permanently delete all run history records.
   * @returns {{ success: boolean }}
   */
  clearRuns() {
    this.db.prepare("DELETE FROM action_runs").run();
    return { success: true };
  }

  /**
   * Delete the oldest runs so that at most `maxRuns` records remain.
   * Passing 0 (or any non-positive value) means "unlimited" - no rows deleted.
   *
   * @param {number} maxRuns  Maximum rows to keep.  0 = unlimited.
   * @returns {{ success: boolean, pruned: number }}
   */
  pruneRuns(maxRuns) {
    const pruned = pruneRunsToLimit(this.db, maxRuns);
    return { success: true, pruned };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  ActionEngineManager,
  // Pure helpers exported for unit testing
  normalizeForMatching,
  matchesTrigger,
  findMatches,
  validateActionPayload,
  tokenizeCommand,
  buildRunRecord,
  pruneRunsToLimit,
};
