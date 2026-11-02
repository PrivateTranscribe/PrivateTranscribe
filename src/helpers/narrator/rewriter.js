"use strict";

/**
 * Rewrites a chat's recap for the ear: one spoken version, one card to glance
 * at, and one level deeper for "tell me more". It runs the Claude CLI on the
 * user's own login with a small fast model, as Converse does: no API key, and
 * ANTHROPIC_API_KEY is removed from the child's environment so a key in the
 * shell is never billed by accident.
 *
 * One CLI process stays up while the narrator runs and takes one request at a
 * time over stream-json. Measured on 2 Nov 2026: a fresh `claude -p` per item
 * took 6.5-7.5 s, almost all of it CLI startup, while a process started ahead
 * answered in 2.4-3.6 s. A process that is spawned and then waits on `-p`
 * stdin does not help: the CLI gives up after 3 s of silence and starts its
 * work only once the input arrives. The process is replaced every
 * MAX_TURNS_PER_PROCESS requests, so its conversation stays short.
 *
 * When the CLI is missing, logged out or slow, a plain template takes over, so
 * a waiting chat is never kept silent by the rewriter.
 */

const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const {
  resolveClaudeBin,
  withoutClaudeBillingEnv,
  resolveClaudeArgPrefix,
} = require("../converseAgent");
const { redact, toSpeakable } = require("./spokenText");

const REWRITE_MODEL = "claude-haiku-5-5";
const REWRITE_TIMEOUT_MS = 20_000;
const MAX_TURNS_PER_PROCESS = 10;

const LANGUAGE_NAME = { da: "Danish", en: "English" };

const SYSTEM_PROMPT = [
  "You rewrite status messages from coding assistant chats so they can be read aloud to a developer who is walking around and not looking at a screen.",
  "Each request says the language to write in and holds one or more items. For one item reply with one JSON object; for several, a JSON array of objects in the same order.",
  'Each object: {"spoken": "...", "card": "...", "more": "..."}. Reply with JSON only.',
  "spoken: at most three short sentences. The first fits in one breath and puts the next step or the question first. Name the chat briefly at the start, as it is called.",
  "card: at most 20 words, for glancing at, in different words from spoken.",
  "more: two to four sentences of background: what happened, why, and what is not done.",
  "In Danish, software words stay English: commit, push, deploy, bug, login, branch, merge, release, test, build, PR. Never translate them.",
  "Explain a name the first time it is used, such as a PR number or an internal module name: say what it is.",
  "Never write code, diffs, paths, file names, links or hashes. Say the point instead.",
  "Invent nothing. If it is not in the item, do not say it. Each request stands alone: never mention items from earlier requests.",
].join(" ");

/** The words a template uses when the CLI cannot answer. */
const TEMPLATE = {
  da: { waits: "venter på dig", done: "er færdig", chat: "En chat" },
  en: { waits: "is waiting on you", done: "has finished", chat: "A chat" },
};

function firstSentence(text) {
  const match = String(text || "").match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (match ? match[0] : String(text || "")).trim();
}

/** The rewrite without a model: title, state, then the ask or the recap's first sentence. */
function templateRewrite(item, language = "da") {
  const words = TEMPLATE[language] || TEMPLATE.da;
  const title = toSpeakable(item.chatTitle) || words.chat;
  const state = item.kind === "waiting" ? words.waits : words.done;
  const lead = toSpeakable(item.ask || firstSentence(item.recap));
  const spoken = lead ? `${title} ${state}. ${lead}` : `${title} ${state}.`;
  return {
    spoken,
    card: redact(item.ask || firstSentence(item.recap), 300),
    more: toSpeakable(item.recap),
    language,
    byModel: false,
  };
}

function toRewrite(value) {
  if (!value || typeof value.spoken !== "string" || !value.spoken.trim()) return null;
  return {
    spoken: value.spoken,
    card: typeof value.card === "string" ? value.card : "",
    more: typeof value.more === "string" ? value.more : "",
  };
}

/**
 * The JSON in a model reply, tolerating a code fence or text around it: an
 * object for one item, an array for several. Null when it is neither.
 */
function parseRewrite(text, count = 1) {
  const raw = String(text || "");
  const open = count > 1 ? "[" : "{";
  const close = count > 1 ? "]" : "}";
  const start = raw.indexOf(open);
  const end = raw.lastIndexOf(close);
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (count === 1) return toRewrite(parsed);
    if (!Array.isArray(parsed) || parsed.length !== count) return null;
    const all = parsed.map(toRewrite);
    return all.every(Boolean) ? all : null;
  } catch {
    return null;
  }
}

/** What the model is given about one item. Redacted before it leaves the machine. */
function describeItem(item) {
  const lines = [`Chat: ${item.chatTitle || "(untitled)"}`];
  if (item.project) lines.push(`Project folder: ${item.project}`);
  lines.push(`State: ${item.kind === "waiting" ? "waits on the user" : "finished a turn"}`);
  if (item.recap) lines.push(`Recap: ${item.recap}`);
  if (item.ask) lines.push(`Question for the user: ${item.ask}`);
  return lines.join("\n");
}

function buildInput(items, language = "da") {
  const list = Array.isArray(items) ? items : [items];
  const head = `Language: ${LANGUAGE_NAME[language] || LANGUAGE_NAME.da}. Items: ${list.length}.`;
  const body = list.map((item, index) => `--- Item ${index + 1}\n${describeItem(item)}`).join("\n");
  return redact(`${head}\n${body}`, 4000 * list.length + 200);
}

function rejection(code, message) {
  return Object.assign(new Error(message), { code });
}

/** True when a CLI reply is a sign-in problem rather than an answer. */
function isLoginProblem(text) {
  return /not logged in|log ?in|\/login|authenticat|invalid api key/i.test(String(text || ""));
}

/**
 * The CLI's environment: the user's own, as a fresh terminal has it. A Claude
 * Code session hands every process it starts its session id, messaging
 * socket, effort and API route, and a CLI that inherits them runs as part of
 * that session: measured on 3 Nov 2026 with the app started from one, it ran
 * a desktop summary step after every answer and thought at the session's
 * effort, and a wait's words came 18.7 s after its turn ended. Only
 * CLAUDE_CONFIG_DIR, which says where the login lives, stays.
 */
function rewriterEnv(baseEnv) {
  const env = withoutClaudeBillingEnv(baseEnv);
  for (const key of Object.keys(env)) {
    const name = key.toUpperCase();
    if (name === "CLAUDE_CONFIG_DIR") continue;
    if (name === "CLAUDECODE" || name.startsWith("CLAUDE_") || name === "ANTHROPIC_BASE_URL") {
      delete env[key];
    }
  }
  return env;
}

/** No tools, no MCP servers, no settings or hooks from any settings file, nothing saved. */
function rewriterArgs({ model = REWRITE_MODEL, systemPrompt = SYSTEM_PROMPT } = {}) {
  return [
    ...resolveClaudeArgPrefix(),
    "--print",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--no-session-persistence",
    "--model",
    model,
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--system-prompt",
    systemPrompt,
  ];
}

/**
 * One `claude` process over stream-json, one request at a time. Each request
 * is a user message; the reply is the `result` of the turn it starts.
 */
class ClaudeStreamClient {
  constructor({
    claudeBin,
    log = () => {},
    model = REWRITE_MODEL,
    systemPrompt = SYSTEM_PROMPT,
  } = {}) {
    this.claudeBin = claudeBin;
    this.log = log;
    this.model = model;
    this.systemPrompt = systemPrompt;
    this.proc = null;
    this.buffer = "";
    this.current = null;
    this.chain = Promise.resolve();
    this.turns = 0;
  }

  /** Starts the process ahead of the first request, so that request skips the CLI's startup. */
  warm() {
    try {
      this._ensure();
    } catch (error) {
      this.log("Narrator rewriter could not start", { error: error.message });
    }
  }

  _ensure() {
    if (this.proc) return this.proc;
    const bin = resolveClaudeBin(this.claudeBin, { cwd: os.tmpdir() });
    if (path.basename(bin) === bin) throw rejection("claude-missing", "Claude Code was not found");
    const args = rewriterArgs({ model: this.model, systemPrompt: this.systemPrompt });
    const proc = spawn(bin, args, {
      cwd: os.tmpdir(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: rewriterEnv(process.env),
    });
    this.proc = proc;
    this.buffer = "";
    this.turns = 0;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => this._onData(chunk));
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-2000);
    });
    proc.on("error", (error) => this._onExit(proc, error.message));
    proc.on("exit", (code) => this._onExit(proc, `exited with ${code}. ${stderr.trim()}`));
    proc.stdin.on("error", () => {});
    return proc;
  }

  _onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message?.type !== "result" || !this.current) continue;
      const { resolve, reject } = this.current;
      this.current = null;
      const text = String(message.result ?? "");
      if (message.is_error) {
        reject(
          rejection(isLoginProblem(text) ? "login" : "cli-error", text || "The rewrite failed")
        );
      } else {
        resolve(text);
      }
    }
  }

  _onExit(proc, reason) {
    if (this.proc !== proc) return;
    this.proc = null;
    if (this.current) {
      const { reject } = this.current;
      this.current = null;
      reject(rejection(isLoginProblem(reason) ? "login" : "cli-exit", `Claude Code ${reason}`));
    }
  }

  /** Sends one request after the ones before it. Resolves with the reply text. */
  request(text, { timeoutMs = REWRITE_TIMEOUT_MS } = {}) {
    const run = () =>
      new Promise((resolve, reject) => {
        let proc;
        try {
          proc = this._ensure();
        } catch (error) {
          reject(error);
          return;
        }
        const timer = setTimeout(() => {
          if (!this.current) return;
          this.current = null;
          // Its state is unknown now; the next request gets a fresh process.
          this.close();
          reject(rejection("timeout", "The rewrite timed out"));
        }, timeoutMs);
        this.current = {
          resolve: (value) => {
            clearTimeout(timer);
            this.turns += 1;
            if (this.turns >= MAX_TURNS_PER_PROCESS) {
              this.close();
              this.warm();
            }
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        const message = {
          type: "user",
          message: { role: "user", content: [{ type: "text", text }] },
        };
        proc.stdin.write(`${JSON.stringify(message)}\n`);
      });
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  close() {
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    try {
      proc.stdin.end();
      proc.kill();
    } catch {
      // Already gone.
    }
  }
}

class NarratorRewriter {
  /**
   * @param {object} [opts]
   * @param {"cli"|"stub"} [opts.mode]  stub skips the CLI (tests, no login)
   * @param {(msg: string, data?: object) => void} [opts.log]
   */
  constructor({
    mode = process.env.PT_NARRATOR_REWRITER || "cli",
    claudeBin,
    log = () => {},
    client,
  } = {}) {
    this.mode = mode;
    this.log = log;
    this.client = client || (mode === "stub" ? null : new ClaudeStreamClient({ claudeBin, log }));
    /** The last reason the CLI could not be used, for the page to show. */
    this.lastError = null;
  }

  warm() {
    this.client?.warm();
  }

  close() {
    this.client?.close();
  }

  /** @returns {Promise<{spoken: string, card: string, more: string, language: string, byModel: boolean}>} */
  async rewrite(item, language = "da") {
    return (await this.rewriteMany([item], language))[0];
  }

  /** One request for several items, as a brief needs. Falls back per call, never per item. */
  async rewriteMany(items, language = "da") {
    const lang = language === "en" ? "en" : "da";
    if (!this.client || items.length === 0) return items.map((item) => templateRewrite(item, lang));
    try {
      const reply = await this.client.request(buildInput(items, lang));
      const parsed = parseRewrite(reply, items.length);
      if (!parsed) throw rejection("bad-reply", "The rewrite was not the JSON asked for");
      this.lastError = null;
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list.map((result, index) => ({
        spoken: toSpeakable(result.spoken),
        card: redact(result.card || firstSentence(result.spoken), 400),
        more: toSpeakable(result.more || items[index].recap),
        language: lang,
        byModel: true,
      }));
    } catch (error) {
      this.lastError = { code: error?.code || "error", message: String(error?.message || error) };
      this.log("Narrator rewrite fell back to the template", this.lastError);
      return items.map((item) => templateRewrite(item, lang));
    }
  }
}

module.exports = {
  NarratorRewriter,
  ClaudeStreamClient,
  templateRewrite,
  parseRewrite,
  buildInput,
  isLoginProblem,
  rewriterEnv,
  rewriterArgs,
  REWRITE_MODEL,
  SYSTEM_PROMPT,
};
