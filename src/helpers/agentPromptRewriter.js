/**
 * Agent Mode's one-shot prompt rewrite, run through the user's own Claude Code
 * CLI in print mode.
 *
 * Hold the key, ramble about a bug, release: this turns the raw transcript into
 * a prompt a coding agent can act on. It replaces a regex pass, so it has to
 * finish while the user is still looking at the screen — which is why the spawn
 * is deliberately slim.
 *
 * Measured on this PC (CLI 2.1.258): a bare `claude --print` on a claude.ai
 * login ships every connector's tool schema plus CLAUDE.md as its system
 * prompt, 16.6 s wall. The flags and environment below cut the input to 507
 * tokens and the wall time to 3.65 s, 1.18 s of it API.
 *
 * `MAX_THINKING_TOKENS=0` is load-bearing, not tidiness: Haiku 4.5 thinks by
 * default in print mode and burned 428 thinking tokens on a 40-token answer,
 * 8.1 s wall, before that variable was set.
 *
 * The ramble goes on stdin rather than a positional argument: a transcript can
 * run long, and a command line has a hard length limit on Windows.
 */

const { spawn: defaultSpawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveClaudeBin, resolveClaudeArgPrefix, probeClaudeBin } = require("./converseAgent");

const AGENT_REWRITE_SYSTEM_PROMPT = `You turn a spoken ramble into a prompt a coding agent can act on. The text is a speech-to-text transcript, so spoken forms of code appear in it.

Rules:
- Outcome first. Open with what the speaker wants done, then the details they gave.
- Keep every technical detail word for word: file names, identifiers, commands, error text, numbers, counts.
- When the speaker changes their mind ("no wait", "actually", "scratch that", "I mean"), keep only the final intent, in the order it was said.
- Write paths, identifiers, commands and error text in backticks. Spoken forms become code: "auth slash login dot ts" is \`auth/login.ts\`, "user underscore id" is \`user_id\`, "crate colon colon parser" is \`crate::parser\`, "use effect" in a React context is \`useEffect\`.
- Short lines. A spoken "new line" or "new paragraph" is a line break.
- Never add facts, never guess at causes the speaker did not state, never do the task, never ask a question unless the speaker asked one.
- Output only the prompt. No preamble, no explanation, no quotes around it.`;

const AGENT_REWRITE_MODEL = "haiku";
const AGENT_REWRITE_TIMEOUT_MS = 12_000;
const AGENT_REWRITE_DIAG_FLAG = "PRIVATETRANSCRIBE_DIAG_DISABLE_AGENT_REWRITE";

/** The settings page polls getStatus(), and on Windows every miss costs a `where`. */
const PROBE_CACHE_MS = 60_000;

const STDERR_CAP_BYTES = 2048;

function log(...args) {
  console.log("[agent-rewrite]", ...args);
}

function isFlagOn(value) {
  return value === "1" || value === "true";
}

function toCount(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildRewriteArgs(systemPrompt, model) {
  return [
    "--print",
    "--model",
    model,
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--tools",
    "",
    "--setting-sources",
    "",
    "--no-session-persistence",
    "--output-format",
    "json",
    "--system-prompt",
    systemPrompt,
  ];
}

function buildRewriteEnv(baseEnv) {
  return {
    ...(baseEnv || {}),
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    MAX_THINKING_TOKENS: "0",
  };
}

let cachedCwd = null;

/**
 * The child runs in a directory created once here and never written to. An
 * empty directory outside any project means the CLI walks up and finds no
 * CLAUDE.md, so the user's repo instructions never ride along as system prompt.
 */
function ensureRewriteCwd() {
  if (cachedCwd) return cachedCwd;
  const dir = path.join(os.tmpdir(), "privatetranscribe-agent-rewrite");
  try {
    fs.mkdirSync(dir, { recursive: true });
    cachedCwd = dir;
  } catch {
    cachedCwd = os.tmpdir();
  }
  return cachedCwd;
}

function cleanResult(raw) {
  let out = typeof raw === "string" ? raw.trim() : "";
  const fenced = out.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fenced) return fenced[1].trim();
  if (out.length >= 2) {
    const first = out[0];
    const inner = out.slice(1, -1);
    // Only a pair with nothing of its kind inside is a wrapper: a prompt that
    // opens with `npm run build` and closes with `package.json` is not wrapped.
    if (
      (first === '"' || first === "'" || first === "`") &&
      out[out.length - 1] === first &&
      !inner.includes(first)
    ) {
      out = inner.trim();
    }
  }
  return out;
}

class AgentPromptRewriter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.claudeBin]
   * @param {string} [opts.model]
   * @param {number} [opts.timeoutMs]
   * @param {object} [opts.env] base environment; a test overrides it
   * @param {Function} [opts.spawn] child_process.spawn; a test overrides it
   */
  constructor({ claudeBin, model, timeoutMs, env, spawn } = {}) {
    this.claudeBin = resolveClaudeBin(claudeBin);
    this.model = model || AGENT_REWRITE_MODEL;
    this.timeoutMs =
      typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : AGENT_REWRITE_TIMEOUT_MS;
    this.env = env || process.env;
    this.spawn = spawn || defaultSpawn;
    this.probeCache = null;
  }

  isDisabled() {
    return isFlagOn(this.env[AGENT_REWRITE_DIAG_FLAG]);
  }

  async probe() {
    const now = Date.now();
    if (this.probeCache && now - this.probeCache.at < PROBE_CACHE_MS) {
      return this.probeCache.found;
    }
    const found = await probeClaudeBin(this.claudeBin);
    this.probeCache = { at: now, found };
    return found;
  }

  async getStatus() {
    if (this.isDisabled()) {
      return { available: false, bin: null, reason: "diagnostic-flag" };
    }
    const found = await this.probe();
    if (found) return { available: true, bin: this.claudeBin };
    return { available: false, bin: this.claudeBin, reason: "not-found" };
  }

  async rewrite(text) {
    const startedAt = Date.now();
    const fail = (reason, message) => {
      const ms = Date.now() - startedAt;
      log(reason, `${ms}ms`, message);
      return { ok: false, reason, message, ms };
    };

    if (this.isDisabled()) return fail("disabled", "Turned off by a diagnostic flag.");
    if (typeof text !== "string" || text.trim() === "") {
      return fail("empty-input", "Nothing was said.");
    }
    if (!(await this.probe())) {
      return fail(
        "not-found",
        `Claude Code CLI not found (tried "${this.claudeBin}"). Check that the claude command runs in a terminal.`
      );
    }

    const args = [
      ...resolveClaudeArgPrefix(),
      ...buildRewriteArgs(AGENT_REWRITE_SYSTEM_PROMPT, this.model),
    ];

    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawn(this.claudeBin, args, {
          cwd: ensureRewriteCwd(),
          env: buildRewriteEnv(this.env),
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        resolve(fail("spawn-error", err && err.message ? err.message : String(err)));
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };

      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
        finish(fail("timeout", `No answer within ${this.timeoutMs} ms.`));
      }, this.timeoutMs);

      if (child.stdout) {
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
      }
      if (child.stderr) {
        child.stderr.on("data", (chunk) => {
          if (stderr.length >= STDERR_CAP_BYTES) return;
          stderr += String(chunk).slice(0, STDERR_CAP_BYTES - stderr.length);
        });
      }

      child.on("error", (err) => {
        if (settled) return;
        finish(fail("spawn-error", err && err.message ? err.message : String(err)));
      });

      // A killed child still emits close; the timeout already owns that outcome.
      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          const detail = stderr.trim() ? stderr.trim().slice(0, 200) : `exit code ${code}`;
          finish(fail("exit", detail));
          return;
        }

        let parsed;
        try {
          parsed = JSON.parse(stdout.trim());
        } catch {
          finish(fail("bad-output", "The CLI did not answer with JSON."));
          return;
        }
        if (!parsed || typeof parsed !== "object") {
          finish(fail("bad-output", "The CLI did not answer with a JSON object."));
          return;
        }
        if (parsed.is_error) {
          const detail =
            typeof parsed.result === "string" && parsed.result.trim()
              ? parsed.result.trim().slice(0, 200)
              : "The CLI reported an error.";
          finish(fail("exit", detail));
          return;
        }

        const cleaned = cleanResult(parsed.result);
        if (!cleaned) {
          finish(fail("empty", "The rewrite came back empty."));
          return;
        }

        const ms = Date.now() - startedAt;
        const apiMs = toCount(parsed.duration_api_ms);
        const usage = parsed.usage || {};
        const inputTokens = toCount(usage.input_tokens);
        const outputTokens = toCount(usage.output_tokens);
        log("ok", `${ms}ms`, `api ${apiMs}ms`, `in ${inputTokens}`, `out ${outputTokens}`);
        finish({ ok: true, text: cleaned, ms, apiMs, inputTokens, outputTokens });
      });

      if (child.stdin) {
        child.stdin.on("error", () => {
          // The child can die before it reads; the close handler owns the outcome.
        });
        child.stdin.end(text);
      }
    });
  }
}

module.exports = {
  AgentPromptRewriter,
  buildRewriteArgs,
  buildRewriteEnv,
  AGENT_REWRITE_SYSTEM_PROMPT,
  AGENT_REWRITE_MODEL,
  AGENT_REWRITE_TIMEOUT_MS,
  AGENT_REWRITE_DIAG_FLAG,
};
