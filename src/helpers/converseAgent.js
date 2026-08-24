/**
 * One persistent `claude` child process for a whole Converse session.
 *
 * Ported from the validated voice-loop spike (C:\tmp\voice-loop-spike,
 * lib/agent.cjs). Spawning `claude` per utterance costs ~2-4s of CLI startup
 * before a single token arrives, which destroys the conversational feel — so
 * the process is started once and each turn is a stream-json user message
 * written to its stdin.
 *
 * Verified accepted input line shape (CLI v2.1.224):
 *   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const VOICE_SYSTEM_PROMPT =
  "You are being used by voice. Answers are spoken aloud by TTS. Be concise and " +
  "conversational. No markdown, no code blocks, no bullet lists, no headers - " +
  "plain spoken sentences only. If asked to do work, do it, then summarize what " +
  "you did in a few spoken sentences. The user can interrupt you mid-answer; " +
  "when that happens, their next message starts with a bracketed note telling " +
  "you exactly which sentences they heard and which were never spoken. Treat " +
  "unheard text as unsaid: pick up from where they actually stopped hearing, " +
  "and never assume they know something you only said in the unheard part.";

/** Deterministic reply used by mock mode. Two sentences, on purpose. */
const MOCK_REPLY_PARTS = ["Mock reply sentence one. ", "Mock reply sentence two."];
const MOCK_FIRST_DELTA_MS = 150;
const MOCK_SECOND_DELTA_MS = 40;

/**
 * Where the `claude` CLI lives.
 *
 * Never hardcoded blindly: an explicit option wins, then the
 * PT_CONVERSE_CLAUDE_BIN override (which is how a test points at a stub), then
 * the per-user install path if it exists on disk, and finally the bare name so
 * PATH resolution gets a chance.
 */
function resolveClaudeBin(explicit) {
  if (explicit) return explicit;
  if (process.env.PT_CONVERSE_CLAUDE_BIN) return process.env.PT_CONVERSE_CLAUDE_BIN;

  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const userInstall = path.join(os.homedir(), ".local", "bin", exe);
  try {
    if (fs.existsSync(userInstall)) return userInstall;
  } catch {
    // Unreadable home directory — fall through to PATH.
  }
  return exe;
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

/** How long a `where`/`which` PATH lookup gets before it counts as not found. */
const PREFLIGHT_TIMEOUT_MS = 3000;

/** True when `bin` names a specific location rather than a bare command name. */
function hasPathComponents(bin) {
  return path.basename(bin) !== bin;
}

/**
 * Resolve whether `claudeBin` will actually spawn, before the real spawn runs.
 *
 * Two cases, because `spawn()` resolves a bare name against PATH itself:
 *   - a path (absolute, relative, or the per-user install path already
 *     verified once by resolveClaudeBin) — checked with fs.existsSync, which
 *     is instant and cannot hang.
 *   - a bare command name (the production default: "claude"/"claude.exe") —
 *     resolved with `where`/`which`, the same PATH scan a user gets by typing
 *     that command in a terminal. This is what the failure copy tells them to
 *     do, so the check and the instruction agree. Actually spawning `claude
 *     --version` was rejected: real CLI startup costs ~2-4s (see the module
 *     doc comment above), which would make every session start pay for it,
 *     and a hung/misbehaving install could block start() far longer than a
 *     PATH lookup ever can.
 */
function probeClaudeBin(bin) {
  return new Promise((resolve) => {
    if (hasPathComponents(bin)) {
      let exists = false;
      try {
        exists = fs.existsSync(bin);
      } catch {
        exists = false;
      }
      resolve(exists);
      return;
    }

    const finder = process.platform === "win32" ? "where" : "which";
    let child;
    try {
      child = spawn(finder, [bin], { stdio: "ignore", windowsHide: true });
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (found) => {
      if (settled) return;
      settled = true;
      resolve(found);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      finish(false);
    }, PREFLIGHT_TIMEOUT_MS);

    child.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
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
  } = {}) {
    this.onDelta = onDelta || (() => {});
    this.onTurnEnd = onTurnEnd || (() => {});
    this.onError = onError || (() => {});
    this.onSessionId = onSessionId || (() => {});
    this.model = model;
    this.cwd = cwd;
    this.claudeBin = resolveClaudeBin(claudeBin);
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
    const found = await probeClaudeBin(this.claudeBin);
    if (!found) {
      const message = `Claude Code CLI not found (tried "${this.claudeBin}"). Check that the claude command runs in a terminal.`;
      this.lastError = message;
      this.ready = false;
      throw Object.assign(new Error(message), { code: "claude-bin-not-found" });
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

    // Relay the harness's own permission questions to the app. The MCP server
    // is spawned by the CLI itself with a bare node (process.execPath would be
    // electron.exe here, which cannot run a plain script), and reaches the app
    // back over loopback HTTP. Never any bypass flag — the CLI's own
    // permission model stays in charge; the app only answers its questions.
    if (this.permissionRelay) {
      const mcpConfig = {
        mcpServers: {
          "pt-permissions": {
            command: process.env.PT_CONVERSE_NODE_BIN || "node",
            args: [path.join(__dirname, "conversePermissionMcp.cjs")],
            env: {
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
      this.onError({ where: "api", message: this.lastError, fellBackToMock: true });
      this._runMockTurn(turn.prompt);
      return;
    }

    this.turns += 1;
    this.onTurnEnd({
      text: turn.text,
      prompt: turn.prompt,
      firstTokenMs: turn.firstTokenMs,
      totalMs: Date.now() - turn.startedAt,
      mode: turn.mode,
      apiError,
      ...info,
    });
  }

  // -------------------------------------------------------------------- mock

  _runMockTurn(prompt) {
    this.turn = {
      text: "",
      prompt,
      startedAt: Date.now(),
      firstTokenMs: null,
      sawDelta: false,
      apiError: null,
      mode: "mock",
    };

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

  /** Returns false if the agent cannot take the utterance right now. */
  send(text) {
    if (this.turn) return false; // one turn at a time

    if (this.agentMode === "mock") {
      this._runMockTurn(text);
      return true;
    }

    if (!this.ready || !this.proc || !this.proc.stdin.writable) return false;

    this.turn = {
      text: "",
      prompt: text,
      startedAt: Date.now(),
      firstTokenMs: null,
      sawDelta: false,
      apiError: null,
      mode: "live",
    };
    const line =
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
      }) + "\n";
    this.proc.stdin.write(line);
    return true;
  }

  stop() {
    for (const handle of this.mockTimers) clearTimeout(handle);
    this.mockTimers.clear();
    this.turn = null;
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
  MOCK_REPLY: MOCK_REPLY_PARTS.join(""),
};
