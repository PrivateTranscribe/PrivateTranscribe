/**
 * One persistent `claude` child process for a whole Converse session.
 *
 * Ported from the validated voice-loop spike's lib/agent.cjs. Spawning `claude`
 * per utterance costs ~2-4s of CLI startup
 * before a single token arrives, which destroys the conversational feel — so
 * the process is started once and each turn is a stream-json user message
 * written to its stdin.
 *
 * Verified accepted input line shape (CLI v2.1.224):
 *   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
 */

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Modeled on the communication rules of OpenAI Codex's realtime voice mode
 * (its backend_prompt.md and realtime_start.md): spoken progress notes during
 * long work instead of silence, no play-by-play, a spoken wrap-up at the end,
 * update-frequency requests treated as sticky task-level preferences, and
 * tolerance for speech-recognition noise in the user's messages. Our
 * architecture differs from Codex's two-model split — here the working agent's
 * own text IS the speech — so the cadence rules Codex gives its voice
 * intermediary are given to the agent directly.
 */
const VOICE_SYSTEM_PROMPT =
  "You are being used by voice. Everything you write is spoken aloud by TTS, " +
  "sentence by sentence, as you write it. Be concise and conversational. No " +
  "markdown, no code blocks, no bullet lists, no headers, no tables - plain " +
  "spoken sentences only. Never read out file contents, diffs, code, or " +
  "structured data; say the key point instead. " +
  "When a task takes more than a few seconds, speak short progress notes " +
  "between steps: one brief sentence about what you just learned or are about " +
  "to do, like 'The bug is in the hotkey manager, fixing it now.' Avoid " +
  "play-by-play, filler, repeated confirmations, and narrating every tool " +
  "call; by default share progress only when it is brief, grounded, and " +
  "genuinely useful. When the work is done, give a short spoken summary of " +
  "what you did and what changed. " +
  "If the user asks for more frequent updates or for less talking, treat that " +
  "as a standing preference for the rest of the task and do not silently " +
  "revert to the default style. " +
  "The user's messages may be voice transcriptions: they can be unpunctuated " +
  "or contain recognition errors, so prefer the interpretation that makes " +
  "sense in context. Messages can also arrive while you are still working; " +
  "they were queued and are answered in order. " +
  "The user can interrupt you mid-answer; when that happens, their next " +
  "message starts with a bracketed note telling you exactly which sentences " +
  "they heard and which were never spoken. Treat unheard text as unsaid: pick " +
  "up from where they actually stopped hearing, and never assume they know " +
  "something you only said in the unheard part.";

/** Deterministic reply used by mock mode. Two sentences, on purpose. */
const MOCK_REPLY_PARTS = ["Mock reply sentence one. ", "Mock reply sentence two."];
const MOCK_FIRST_DELTA_MS = 150;
const MOCK_SECOND_DELTA_MS = 40;

/** True when `dir` is a full path that cannot mean "relative to the cwd". */
function isFullyQualifiedDir(dir) {
  if (process.platform === "win32") return /^([a-zA-Z]:[\\/]|\\\\)/.test(dir);
  return path.isAbsolute(dir);
}

/** Same directory spelled two ways must compare equal. */
function dirKey(dir) {
  const resolved = path.resolve(String(dir || "")).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Absolute path of `name` in a fully qualified PATH directory, or null. Never the
 * cwd or `exclude`: Windows `where` and spawn() try the cwd first, so a planted
 * `claude.exe` in a cloned repo would run instead of the real one.
 */
function findOnPath(name, { exclude = [] } = {}) {
  const pathVar = process.env.PATH || process.env.Path || "";
  const names = process.platform === "win32" && !path.extname(name) ? [`${name}.exe`] : [name];
  const excluded = new Set(exclude.filter(Boolean).map(dirKey));
  for (const raw of pathVar.split(path.delimiter)) {
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || !isFullyQualifiedDir(dir) || excluded.has(dirKey(dir))) continue;
    for (const candidate of names) {
      const full = path.join(dir, candidate);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        // Not in this directory.
      }
    }
  }
  return null;
}

/**
 * The `claude` CLI as an absolute path: explicit option, PT_CONVERSE_CLAUDE_BIN
 * (test stubs), the per-user install, then PATH minus `opts.cwd`. Not found
 * returns the bare name, which start() refuses to spawn.
 */
function resolveClaudeBin(explicit, { cwd } = {}) {
  const exclude = cwd ? [cwd] : [];
  const override = explicit || process.env.PT_CONVERSE_CLAUDE_BIN;
  if (override) {
    if (hasPathComponents(override)) return path.resolve(override);
    return findOnPath(override, { exclude }) || override;
  }

  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const userInstall = path.join(os.homedir(), ".local", "bin", exe);
  try {
    if (fs.existsSync(userInstall)) return userInstall;
  } catch {
    // Unreadable home directory — fall through to PATH.
  }
  return findOnPath(exe, { exclude }) || exe;
}

// ------------------------------------------------------------ folder trust

/**
 * Project files Claude Code loads on its own. --print mode shows no "trust this
 * folder?" prompt, so their hooks and allow rules would apply unseen. All of
 * .claude counts: agents, skills, commands and rules load from it, and hook
 * scripts usually live there, so a trusted settings file cannot run a changed one.
 */
const FOLDER_CONFIG_FILES = [".mcp.json", "CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"];
const FOLDER_CONFIG_DIR = ".claude";
/** Hashed directly and listed first, whatever the walk of .claude does. */
const FOLDER_CONFIG_FIRST = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/CLAUDE.md",
  ".claude/AGENTS.md",
];
/** Claude Code's own worktrees are whole checkouts, not configuration. */
const FOLDER_CONFIG_SKIP = new Set([".claude/worktrees"]);
/** Past this many files the rest count as one entry, so a change in them still asks. */
const MAX_TRUST_FILES = 500;
/**
 * The walk stops here and a file this big is not read, so a link to a huge folder
 * cannot stall the main process. Either one makes the folder impossible to trust.
 */
const MAX_WALK_FILES = 5000;
const MAX_HASH_BYTES = 64 * 1024 * 1024;

const TRUST_STORE_FILE = "converse-folder-trust.json";

/** Start of the error start() throws for an untrusted folder; the page matches on it. */
const FOLDER_TRUST_REQUIRED_MESSAGE =
  "This folder has Claude Code settings you have not trusted yet";

/**
 * Where trust decisions live: Electron's userData, never the folder itself (a
 * repo could otherwise ship its own "already trusted" mark). Outside Electron
 * with no explicit path there is no store, so nothing counts as trusted.
 */
function resolveTrustStorePath(explicitPath) {
  if (explicitPath) return explicitPath;
  if (process.env.PT_CONVERSE_TRUST_STORE) return process.env.PT_CONVERSE_TRUST_STORE;
  try {
    const { app } = require("electron");
    if (app && typeof app.getPath === "function") {
      return path.join(app.getPath("userData"), TRUST_STORE_FILE);
    }
  } catch {
    // Not running inside Electron.
  }
  return null;
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** A value no trust record can hold, for anything the scan could not read. */
const unverifiable = () => crypto.randomBytes(32).toString("hex");

/** Content hash read in chunks; unverifiable() when the file is too big or unreadable. */
function hashFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    if (fs.fstatSync(fd).size > MAX_HASH_BYTES) return unverifiable();
    const hash = crypto.createHash("sha256");
    const chunk = Buffer.alloc(1024 * 1024);
    let read;
    while ((read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      hash.update(chunk.subarray(0, read));
    }
    return hash.digest("hex");
  } catch {
    return unverifiable();
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Relative paths of every file under .claude apart from FOLDER_CONFIG_FIRST,
 * skipping FOLDER_CONFIG_SKIP, sorted. Linked folders are followed, because
 * Claude Code follows them too; each real folder is walked once, so a link loop ends.
 */
function listConfigDir(folder) {
  const out = [];
  const seen = new Set();
  let truncated = false;
  const walk = (rel) => {
    const abs = path.join(folder, ...rel.split("/"));
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch {
      return; // A broken link loads nothing.
    }
    const key = process.platform === "win32" ? real.toLowerCase() : real;
    if (seen.has(key)) return;
    seen.add(key);

    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_WALK_FILES) {
        truncated = true;
        return;
      }
      const child = `${rel}/${entry.name}`;
      if (FOLDER_CONFIG_SKIP.has(child)) continue;
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDir = fs.statSync(path.join(folder, ...child.split("/"))).isDirectory();
        } catch {
          continue;
        }
      }
      if (isDir) walk(child);
      else if (!FOLDER_CONFIG_FIRST.includes(child)) out.push(child);
    }
  };
  walk(FOLDER_CONFIG_DIR);
  out.sort();
  return { files: out, truncated };
}

/**
 * The Claude Code config files present in `folder`, each with a SHA-256 of its
 * content. A modified time is not enough: an archive can restore the one the
 * user trusted on different content. Anything the scan cannot verify gets a
 * value that never matches, so the folder keeps asking rather than passing.
 */
function scanFolderConfig(folder) {
  const found = [];
  const add = (rel) => {
    const file = path.join(folder, ...rel.split("/"));
    try {
      if (!fs.statSync(file).isFile()) return;
    } catch {
      return; // Not there.
    }
    found.push({ file: rel, sha256: hashFile(file) });
  };
  for (const rel of [...FOLDER_CONFIG_FILES, ...FOLDER_CONFIG_FIRST]) add(rel);

  const { files: inDir, truncated } = listConfigDir(folder);
  for (const rel of inDir.slice(0, MAX_TRUST_FILES)) add(rel);
  const rest = inDir.slice(MAX_TRUST_FILES);
  if (truncated) {
    found.push({
      file: `${FOLDER_CONFIG_DIR}/ (over ${MAX_WALK_FILES} files, too many to check)`,
      sha256: unverifiable(),
    });
  } else if (rest.length > 0) {
    const digest = crypto.createHash("sha256");
    for (const rel of rest) {
      digest.update(`${rel}\0${hashFile(path.join(folder, ...rel.split("/")))}\n`);
    }
    found.push({
      file: `${FOLDER_CONFIG_DIR}/ (${rest.length} more files)`,
      sha256: digest.digest("hex"),
    });
  }
  return found;
}

function readTrustStore(storePath) {
  if (!storePath) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Whether `folder` needs the user's trust before Claude Code starts in it. A
 * trusted folder asks again when a file is new or its content differs from
 * what the user was shown; each file is "new", "changed" or "trusted".
 */
function checkFolderTrust(folder, { storePath } = {}) {
  const files = scanFolderConfig(folder);
  if (files.length === 0) return { needsTrust: false, reason: "no-config", files: [] };

  const record = readTrustStore(resolveTrustStorePath(storePath))[dirKey(folder)];
  const known = record && record.files && typeof record.files === "object" ? record.files : null;
  if (!known) {
    return {
      needsTrust: true,
      reason: "untrusted",
      files: files.map((f) => ({ ...f, status: "new" })),
    };
  }

  const marked = files.map((f) => ({
    ...f,
    status: !Object.hasOwn(known, f.file)
      ? "new"
      : known[f.file] !== f.sha256
        ? "changed"
        : "trusted",
  }));
  const changed = marked.some((f) => f.status !== "trusted");
  return { needsTrust: changed, reason: changed ? "changed" : "trusted", files: marked };
}

/**
 * Record that the user trusts `folder` as they saw it. `shownFiles` is the
 * snapshot the prompt listed, so a file that changes between the prompt and
 * the click is still not trusted. Returns the fresh check.
 */
function trustFolder(folder, shownFiles, { storePath } = {}) {
  const file = resolveTrustStorePath(storePath);
  if (!file) throw new Error("There is nowhere to remember trusted folders.");

  const snapshot = Array.isArray(shownFiles) ? shownFiles : scanFolderConfig(folder);
  const files = {};
  for (const entry of snapshot) {
    if (!entry || typeof entry.file !== "string") continue;
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) continue;
    files[entry.file] = entry.sha256;
  }

  const store = readTrustStore(file);
  store[dirKey(folder)] = { trustedAt: Date.now(), files };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return checkFolderTrust(folder, { storePath: file });
}

/**
 * Extra arguments placed BEFORE the CLI flags, from PT_CONVERSE_CLAUDE_ARGS
 * (a JSON array of strings). Empty unless the variable is set, so the real
 * spawn is byte-identical to what it was.
 *
 * This exists for one reason: on Windows, Node refuses to spawn a `.cmd`
 * without a shell, so a test cannot point PT_CONVERSE_CLAUDE_BIN at a batch
 * shim. Instead it points the binary at `node` and passes the stub script
 * through here — `node <stub.cjs> --print --verbose ...` — which keeps the
 * production path free of `shell: true`.
 */
function resolveClaudeArgPrefix() {
  const raw = process.env.PT_CONVERSE_CLAUDE_ARGS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function log(...args) {
  console.log("[converse-agent]", ...args);
}

/** True when `bin` names a specific location rather than a bare command name. */
function hasPathComponents(bin) {
  return path.basename(bin) !== bin;
}

/**
 * Whether `claudeBin` exists, checked before the real spawn. Spawning `claude
 * --version` was rejected: CLI startup costs ~2-4s. A bare name is looked up
 * with findOnPath rather than `where`, which would search the cwd first.
 */
function probeClaudeBin(bin) {
  if (!hasPathComponents(bin)) return Promise.resolve(Boolean(findOnPath(bin)));
  try {
    return Promise.resolve(fs.existsSync(bin));
  } catch {
    return Promise.resolve(false);
  }
}

class ConverseAgent {
  /**
   * @param {object} opts
   * @param {(text:string)=>void} [opts.onDelta]    streamed assistant text
   * @param {(info:object)=>void} [opts.onTurnEnd]  fired once per turn
   * @param {(err:object)=>void}  [opts.onError]    non-fatal agent problems
   * @param {string}  [opts.model]
   * @param {string}  [opts.cwd]
   * @param {string}  [opts.claudeBin]
   * @param {boolean} [opts.mock] start in mock mode instead of spawning the CLI
   * @param {(id:string)=>void} [opts.onSessionId] fired the first time the CLI
   *   announces its session id (and again if it ever changes)
   * @param {string|null} [opts.resumeSessionId] continue this CLI session
   *   instead of starting a fresh one
   * @param {boolean} [opts.sessionPersistence] when false, pass
   *   `--no-session-persistence`. Defaults to true, because a session the CLI
   *   never writes to disk can never be resumed.
   */
  constructor({
    onDelta,
    onTurnStart,
    onTurnEnd,
    onError,
    onSessionId,
    model = "haiku",
    cwd = os.tmpdir(),
    claudeBin,
    mock = false,
    resumeSessionId = null,
    sessionPersistence = true,
    permissionRelay = null,
    strictMcpConfig = false,
    settingsFile = null,
    trustStorePath = null,
  } = {}) {
    this.onDelta = onDelta || (() => {});
    /** Fired when a turn becomes the one producing output — immediately for a
     * turn sent while idle, at dequeue time for a queued one. */
    this.onTurnStart = onTurnStart || (() => {});
    this.onTurnEnd = onTurnEnd || (() => {});
    this.onError = onError || (() => {});
    this.onSessionId = onSessionId || (() => {});
    this.model = model;
    this.cwd = cwd;
    this.claudeBin = resolveClaudeBin(claudeBin, { cwd });
    this.claudeArgPrefix = resolveClaudeArgPrefix();
    this.resumeSessionId = resumeSessionId || null;
    this.sessionPersistence = sessionPersistence !== false;
    /** { port, token } of the app's permission relay, or null for none. */
    this.permissionRelay = permissionRelay || null;
    /**
     * Whether to pass `--strict-mcp-config` alongside the relay's own
     * `--mcp-config`. Default OFF, and it must stay off for real sessions:
     * strict mode makes the CLI ignore every MCP server the user configured for
     * that project and use ONLY the one the app passes. Converse is a voice
     * front-end onto the user's own Claude Code, not a replacement for it —
     * silently amputating their MCP servers the moment they talk instead of
     * type would make the app degrade their setup. Only a test that wants a
     * hermetic CLI (converse-permission.live.ts) turns it on.
     */
    this.strictMcpConfig = Boolean(strictMcpConfig);
    /** Path to a --settings file (tests use it to force an empty allowlist). */
    this.settingsFile = settingsFile || null;
    /** Where folder trust is remembered; null means Electron's userData. */
    this.trustStorePath = trustStorePath || null;

    /** "live" while the real CLI is answering; "mock" once it cannot. */
    this.agentMode = mock ? "mock" : "live";
    /** Raw error string that forced the fallback — the gate report needs it verbatim. */
    this.lastError = null;
    this.fellBackAt = null;

    this.proc = null;
    this.ready = false;
    this.startupMs = 0;
    this.buf = "";
    this.turn = null;
    /**
     * Utterances sent while a turn was still running. The CLI itself queues
     * stdin user messages and runs each as its own turn after the current one
     * finishes (verified against v2.1.224: two user lines produce two result
     * events in order, the second processed only after the first completes) —
     * this queue exists so *our* turn accounting follows the CLI's.
     */
    this.queuedTurns = [];
    this.turns = 0;
    this.sessionId = null;
    this.mockTimers = new Set();
  }

  async start() {
    const started = Date.now();

    if (this.agentMode === "mock") {
      this.ready = true;
      this.startupMs = Date.now() - started;
      return this.startupMs;
    }

    // The old bug: spawn() was trusted optimistically and `ready` was set
    // synchronously right after the call, so a missing binary only surfaced
    // later as an async ENOENT on the child's `error` event — by which point
    // converse-start had already resolved, the page had already shown "Session
    // ready", and the user only learned the truth after typing a message that
    // came back refused. Checking first means a bad binary fails start()
    // itself, before anything downstream believes the session is usable.
    // A bare name never reaches spawn(): on Windows it would search the cwd,
    // which is the user's project folder, before PATH.
    const found = hasPathComponents(this.claudeBin) && (await probeClaudeBin(this.claudeBin));
    if (!found) {
      const message = `Claude Code CLI not found (tried "${this.claudeBin}"). Check that the claude command runs in a terminal.`;
      this.lastError = message;
      this.ready = false;
      throw Object.assign(new Error(message), { code: "claude-bin-not-found" });
    }

    // The page asks before this point; refusing here as well means no other
    // caller can start the CLI in a folder whose own config was never shown.
    const trust = checkFolderTrust(this.cwd, { storePath: this.trustStorePath });
    if (trust.needsTrust) {
      const message = `${FOLDER_TRUST_REQUIRED_MESSAGE} (${trust.files.map((f) => f.file).join(", ")})`;
      this.lastError = message;
      this.ready = false;
      throw Object.assign(new Error(message), { code: "folder-trust-required", trust });
    }

    const args = [
      "--print",
      "--verbose", // stream-json output is rejected without it
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
    ];

    // Persistence is ON by default: `--resume` can only reach a session the CLI
    // actually wrote to disk, so suppressing it would make resume impossible.
    if (!this.sessionPersistence) args.push("--no-session-persistence");

    args.push("--model", this.model, "--system-prompt", VOICE_SYSTEM_PROMPT);

    // Resuming restores the conversation, not the invocation: the CLI does not
    // remember the flags the original session was started with, so every flag
    // above is re-passed here rather than assumed.
    if (this.resumeSessionId) args.push("--resume", this.resumeSessionId);

    if (this.settingsFile) args.push("--settings", this.settingsFile);

    // Relay the harness's own permission questions to the app over loopback
    // HTTP. The relay runs on the app's own executable in Node mode: a bare
    // `node` would be looked up in the project folder first on Windows.
    if (this.permissionRelay) {
      const mcpConfig = {
        mcpServers: {
          "pt-permissions": {
            command: process.execPath,
            args: [path.join(__dirname, "conversePermissionMcp.cjs")],
            env: {
              ELECTRON_RUN_AS_NODE: "1",
              PT_PERMISSION_RELAY_PORT: String(this.permissionRelay.port),
              PT_PERMISSION_RELAY_TOKEN: this.permissionRelay.token,
            },
          },
        },
      };
      const mcpConfigPath = path.join(
        os.tmpdir(),
        `pt-converse-mcp-${process.pid}-${Date.now()}.json`
      );
      fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));
      this.mcpConfigPath = mcpConfigPath;
      args.push(
        "--permission-prompt-tool",
        "mcp__pt-permissions__approve",
        "--mcp-config",
        mcpConfigPath
      );
      // See this.strictMcpConfig: off for real sessions on purpose, so the
      // user's own project MCP servers keep loading.
      if (this.strictMcpConfig) args.push("--strict-mcp-config");
    }

    this.proc = spawn(this.claudeBin, [...this.claudeArgPrefix, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      cwd: this.cwd,
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this._onStdout(chunk));
    this.proc.stderr.on("data", (data) => {
      const text = String(data).trim();
      if (text) log("stderr", text.slice(0, 300));
    });
    this.proc.on("error", (err) => {
      log("spawn error", err.message);
      this.lastError = err.message;
      this.ready = false;
      this.onError({ where: "spawn", message: err.message });
    });
    this.proc.on("exit", (code) => {
      log("exited", code);
      this.ready = false;
      this.proc = null;
      // Queued turns died with the process; clear before finishing the current
      // turn so _finishTurn does not try to begin one on a dead stdin.
      this.queuedTurns = [];
      if (this.turn) this._finishTurn({ reason: "process-exit", code });
    });

    // The process is usable as soon as it is spawned; the CLI buffers stdin
    // until it has finished its own init. Mark ready immediately and let the
    // first turn absorb whatever init cost remains.
    this.ready = true;
    this.startupMs = Date.now() - started;
    return this.startupMs;
  }

  // ------------------------------------------------------------- stream-json

  _onStdout(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      this._onEvent(evt);
    }
  }

  _onEvent(evt) {
    // Every stream-json line the CLI writes carries the session id at the top
    // level — `{"type":"system","subtype":"init",...,"session_id":"<uuid>"}` is
    // the documented one, but on this machine the earliest carrier is a
    // `system/hook_started` line emitted at spawn time (v2.1.224). Reading the
    // field off any line, rather than off `init` specifically, means the id is
    // known as early as the CLI is willing to say it.
    if (evt.session_id && evt.session_id !== this.sessionId) {
      this.sessionId = evt.session_id;
      try {
        this.onSessionId(this.sessionId);
      } catch (err) {
        log("onSessionId threw", err.message);
      }
    }

    // Partial text as it is generated.
    if (evt.type === "stream_event" && evt.event) {
      const e = evt.event;
      if (e.type === "content_block_delta" && e.delta && e.delta.type === "text_delta") {
        this._emit(e.delta.text);
      }
      return;
    }

    // Whole assistant message. Only used when no deltas arrived (short answers
    // sometimes land as one block, and API error messages always do).
    if (evt.type === "assistant" && evt.message) {
      if (evt.error || evt.is_api_error_message) {
        const text = (evt.message.content || [])
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join(" ");
        this.lastError = text || String(evt.error) || "api error";
        if (this.turn) this.turn.apiError = this.lastError;
        return;
      }
      if (this.turn && !this.turn.sawDelta) {
        const text = (evt.message.content || [])
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join(" ");
        if (text) this._emit(text);
      }
      return;
    }

    if (evt.type === "result") {
      // A result with no turn in flight means the CLI failed before any
      // utterance was sent — the shape a stale `--resume <id>` takes, where the
      // CLI writes "No conversation found with session ID: <id>" to stderr and
      // exits. Keep it as lastError instead of dropping it on the floor.
      if (!this.turn) {
        if (evt.is_error) {
          this.lastError = String(evt.result || evt.subtype || "agent failed at startup");
          this.onError({ where: "startup", message: this.lastError });
        }
        return;
      }
      this._finishTurn({
        reason: evt.subtype || "result",
        isError: Boolean(evt.is_error),
        apiErrorStatus: evt.api_error_status || null,
        durationMs: evt.duration_ms,
        result: evt.result,
      });
    }
  }

  _emit(text) {
    if (!text || !this.turn) return;
    if (!this.turn.sawDelta) {
      this.turn.sawDelta = true;
      this.turn.firstTokenMs = Date.now() - this.turn.startedAt;
    }
    this.turn.text += text;
    this.onDelta(text);
  }

  _finishTurn(info) {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;

    const apiError = turn.apiError || (info.isError ? info.result : null);

    // The live CLI answered with an API error (rate limit, auth, overload).
    // Fall back so the loop still completes, and say so loudly in the state
    // rather than pretending the agent worked. Only an api-error triggers this:
    // an ordinary empty answer must not silently become a mock reply.
    if (apiError && this.agentMode === "live") {
      this.lastError = String(apiError);
      this.fellBackAt = Date.now();
      this.agentMode = "mock";
      log("falling back to mock:", this.lastError.slice(0, 200));
      // Utterances queued behind the failed turn were written to a CLI that
      // just proved unreliable; running them against mock too would answer
      // real requests with canned text. Dropped, and said so.
      if (this.queuedTurns.length > 0) {
        log("dropping", this.queuedTurns.length, "queued turns on mock fallback");
        this.queuedTurns = [];
      }
      this.onError({ where: "api", message: this.lastError, fellBackToMock: true });
      this._runMockTurn(turn.prompt, turn.meta);
      return;
    }

    this.turns += 1;
    this.onTurnEnd({
      text: turn.text,
      prompt: turn.prompt,
      gen: turn.meta?.gen,
      firstTokenMs: turn.firstTokenMs,
      totalMs: Date.now() - turn.startedAt,
      mode: turn.mode,
      apiError,
      ...info,
    });

    // The CLI has already started on the next queued message; follow it.
    const next = this.queuedTurns.shift();
    if (next) {
      if (this.agentMode === "mock") {
        this._runMockTurn(next.text, next.meta);
      } else {
        this._beginTurn(next.text, next.meta, "live");
      }
    }
  }

  _beginTurn(prompt, meta, mode) {
    this.turn = {
      text: "",
      prompt,
      meta: meta || null,
      startedAt: Date.now(),
      firstTokenMs: null,
      sawDelta: false,
      apiError: null,
      mode,
    };
    try {
      this.onTurnStart({ gen: meta?.gen, prompt });
    } catch (err) {
      log("onTurnStart threw", err.message);
    }
  }

  // -------------------------------------------------------------------- mock

  _runMockTurn(prompt, meta) {
    this._beginTurn(prompt, meta, "mock");

    const timer = (fn, ms) => {
      const handle = setTimeout(() => {
        this.mockTimers.delete(handle);
        fn();
      }, ms);
      this.mockTimers.add(handle);
    };

    timer(() => {
      this._emit(MOCK_REPLY_PARTS[0]);
      timer(() => {
        this._emit(MOCK_REPLY_PARTS[1]);
        this._finishTurn({ reason: "mock" });
      }, MOCK_SECOND_DELTA_MS);
    }, MOCK_FIRST_DELTA_MS);
  }

  // -------------------------------------------------------------------- send

  /**
   * Returns false if the agent cannot take the utterance right now. An
   * utterance sent while a turn is running is accepted and QUEUED: in live
   * mode it is written to the CLI immediately (the CLI runs stdin messages in
   * order, each as its own turn), in mock mode it runs after the current mock
   * turn — so a user can keep talking while the agent works, the way Codex
   * queues follow-ups instead of refusing them.
   */
  send(text, meta = {}) {
    if (this.agentMode === "mock") {
      if (this.turn) {
        this.queuedTurns.push({ text, meta });
        return true;
      }
      this._runMockTurn(text, meta);
      return true;
    }

    if (!this.ready || !this.proc || !this.proc.stdin.writable) return false;

    const line =
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
      }) + "\n";

    if (this.turn) {
      this.queuedTurns.push({ text, meta });
      this.proc.stdin.write(line);
      return true;
    }

    this._beginTurn(text, meta, "live");
    this.proc.stdin.write(line);
    return true;
  }

  stop() {
    for (const handle of this.mockTimers) clearTimeout(handle);
    this.mockTimers.clear();
    this.turn = null;
    this.queuedTurns = [];
    this.ready = false;

    if (this.mcpConfigPath) {
      try {
        fs.unlinkSync(this.mcpConfigPath);
      } catch {
        // Already gone.
      }
      this.mcpConfigPath = null;
    }

    if (!this.proc) return;
    try {
      this.proc.stdin.end();
    } catch {
      // Already closed.
    }
    try {
      this.proc.kill();
    } catch {
      // Already gone.
    }
    this.proc = null;
  }

  status() {
    return {
      state: this.ready ? "ready" : "down",
      agentMode: this.agentMode,
      model: this.model,
      bin: this.agentMode === "mock" && !this.proc ? null : this.claudeBin,
      startupMs: this.startupMs,
      turns: this.turns,
      busy: Boolean(this.turn),
      queuedTurns: this.queuedTurns.length,
      sessionId: this.sessionId,
      resumedFrom: this.resumeSessionId,
      sessionPersistence: this.sessionPersistence,
      lastError: this.lastError,
      fellBackAt: this.fellBackAt,
    };
  }
}

module.exports = {
  ConverseAgent,
  VOICE_SYSTEM_PROMPT,
  resolveClaudeBin,
  resolveClaudeArgPrefix,
  probeClaudeBin,
  hasPathComponents,
  findOnPath,
  FOLDER_CONFIG_FILES,
  FOLDER_TRUST_REQUIRED_MESSAGE,
  checkFolderTrust,
  trustFolder,
  resolveTrustStorePath,
  MOCK_REPLY: MOCK_REPLY_PARTS.join(""),
};
