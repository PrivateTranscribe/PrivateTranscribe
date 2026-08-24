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
   */
  constructor({
    onDelta,
    onTurnEnd,
    onError,
    model = "haiku",
    cwd = os.tmpdir(),
    claudeBin,
    mock = false,
  } = {}) {
    this.onDelta = onDelta || (() => {});
    this.onTurnEnd = onTurnEnd || (() => {});
    this.onError = onError || (() => {});
    this.model = model;
    this.cwd = cwd;
    this.claudeBin = resolveClaudeBin(claudeBin);
    this.claudeArgPrefix = resolveClaudeArgPrefix();

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

    const args = [
      "--print",
      "--verbose", // stream-json output is rejected without it
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--no-session-persistence",
      "--model",
      this.model,
      "--system-prompt",
      VOICE_SYSTEM_PROMPT,
    ];

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
    if (evt.session_id) this.sessionId = evt.session_id;

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
  MOCK_REPLY: MOCK_REPLY_PARTS.join(""),
};
