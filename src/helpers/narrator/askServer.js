"use strict";

/**
 * The app's end of the ask_by_voice tool: a local HTTP server that the stdio
 * MCP bridge (askByVoiceMcp.cjs) posts a chat's question to. The request is
 * held open until the narrator has the answer.
 *
 *   Claude Code ─stdio─▶ askByVoiceMcp.cjs ─HTTP 127.0.0.1─▶ this ─▶ narrator.askByVoice()
 *
 * Only this machine reaches it, and only a caller that can read the app's
 * data folder: it listens on 127.0.0.1 alone, on a port the system picks, and
 * each run makes a fresh token, written with the port to narrator-ask.json in
 * that folder. A web page cannot get in. It cannot read the token, a request
 * carrying an Origin header is refused, and so is a Host header that is not
 * this address, which stops DNS rebinding.
 *
 * The bridge script is copied into the data folder too, so the one line that
 * adds it to Claude Code stays the same across updates and installs.
 *
 * Nothing a request carries is logged: not the question, not the token.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { SESSION_ID } = require("./narratorMode");

const ADDRESS_FILE = "narrator-ask.json";
const BRIDGE_FILE = "ask-by-voice-mcp.cjs";
const BRIDGE_SOURCE = path.join(__dirname, "askByVoiceMcp.cjs");
const MAX_BODY_BYTES = 16 * 1024;
/** The narrator answers well within this; it only guards against a hang. */
const ANSWER_TIMEOUT_MS = 45_000;

const LIMITS = { question: 300, choice: 80, chat: 60, choices: 4 };

/** Collapses every run of whitespace, newlines included, to one space. */
function oneLine(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/**
 * Checks a question as the bridge sends it. Returns {value} with the cleaned
 * question, or {error} with what is wrong, worded for the calling agent.
 */
function readQuestion(body) {
  const question = oneLine(body?.question);
  if (!question || question.length > LIMITS.question) {
    return { error: `question must be one line of 1 to ${LIMITS.question} characters` };
  }
  const raw = Array.isArray(body?.choices) ? body.choices : null;
  const choices = raw ? raw.map(oneLine) : [];
  const distinct = new Set(choices.map((choice) => choice.toLowerCase()));
  if (
    !raw ||
    choices.length < 1 ||
    choices.length > LIMITS.choices ||
    choices.some((choice) => !choice || choice.length > LIMITS.choice) ||
    distinct.size !== choices.length
  ) {
    return {
      error: `choices must be 1 to ${LIMITS.choices} different labels of up to ${LIMITS.choice} characters`,
    };
  }
  const chat = oneLine(body?.chat);
  if (!chat || chat.length > LIMITS.chat) {
    return { error: `chat must be a short name of 1 to ${LIMITS.chat} characters` };
  }
  const sessionId =
    typeof body?.sessionId === "string" && SESSION_ID.test(body.sessionId) ? body.sessionId : null;
  const cwd = typeof body?.cwd === "string" && body.cwd.length <= 1000 ? body.cwd : "";
  return { value: { question, choices, chat, sessionId, cwd } };
}

function tokensMatch(given, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, status, payload) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

class NarratorAskServer {
  /**
   * @param {object} deps
   * @param {string} deps.dataDir   the app's data folder; the address file and the bridge go there
   * @param {(question: object, opts: {signal: AbortSignal}) => Promise<object>} deps.ask
   *   resolves with what the tool returns: {answer} or {answer: null, reason}
   */
  constructor({ dataDir, ask, log = () => {} }) {
    this.dataDir = dataDir;
    this.ask = ask;
    this.log = log;
    this.server = null;
    this.port = 0;
    this.token = "";
    this.starting = null;
  }

  get running() {
    return Boolean(this.server);
  }

  get addressFile() {
    return path.join(this.dataDir, ADDRESS_FILE);
  }

  start() {
    if (!this.starting) {
      // One run: its own server and token, so a stop that overlaps a new start
      // closes only what it was given.
      const run = { server: null, token: crypto.randomBytes(32).toString("hex"), port: 0 };
      const starting = (async () => {
        const server = http.createServer((req, res) => this._handle(req, res, run));
        run.server = server;
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
          });
        });
        // Requests are held open for up to 40 s; Node's own limits must not cut them.
        server.requestTimeout = 0;
        server.headersTimeout = 10_000;
        run.port = server.address().port;
        // Stopped while it opened: the stop closes it, and it never says where it is.
        if (this.starting !== starting) return run;
        this.server = server;
        this.token = run.token;
        this.port = run.port;
        await this._writeAddress(run);
        await this._copyBridge();
        return run;
      })().catch((error) => {
        this.log("Narrator could not open ask_by_voice", { error: error.message });
        if (this.starting === starting) this.starting = null;
        if (this.server === run.server) this.server = null;
        run.server?.close();
        throw error;
      });
      this.starting = starting;
    }
    return this.starting.then((run) => ({ port: run.port }));
  }

  async stop() {
    const starting = this.starting;
    this.starting = null;
    if (!starting) return;
    let run;
    try {
      run = await starting;
    } catch {
      return;
    }
    if (this.server === run.server) this.server = null;
    // New calls are refused from now on; a question being answered still gets its answer.
    run.server.close();
    run.server.closeIdleConnections?.();
    await this._removeAddress(run.token);
  }

  /** Stops at once, for quitting: nothing is awaited. */
  close() {
    this.starting = null;
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.close();
    server.closeAllConnections?.();
    try {
      const saved = JSON.parse(fs.readFileSync(this.addressFile, "utf8"));
      if (saved?.token === this.token) fs.unlinkSync(this.addressFile);
    } catch {
      // Gone already, or not ours.
    }
  }

  async _writeAddress({ port, token }) {
    const file = this.addressFile;
    const temp = `${file}.${process.pid}.tmp`;
    const body = JSON.stringify({ port, token, pid: process.pid });
    await fsp.mkdir(this.dataDir, { recursive: true });
    await fsp.writeFile(temp, body, { mode: 0o600 });
    await fsp.rename(temp, file);
  }

  /** Removes the address file, unless another run has written its own since. */
  async _removeAddress(token) {
    try {
      const saved = JSON.parse(await fsp.readFile(this.addressFile, "utf8"));
      if (saved?.token === token) await fsp.unlink(this.addressFile);
    } catch {
      // Gone already, or not ours.
    }
  }

  async _copyBridge() {
    const target = path.join(this.dataDir, BRIDGE_FILE);
    try {
      const source = await fsp.readFile(BRIDGE_SOURCE);
      let current = null;
      try {
        current = await fsp.readFile(target);
      } catch {
        // Not there yet.
      }
      if (!current || !current.equals(source)) await fsp.writeFile(target, source);
    } catch (error) {
      this.log("Narrator could not copy the ask_by_voice bridge", { error: error.message });
    }
  }

  /** One request to one run's server, checked against that run's own port and token. */
  _handle(req, res, run) {
    // A browser always says where a request comes from; the bridge never does.
    if (req.headers.origin !== undefined) return send(res, 403, { error: "forbidden" });
    const host = String(req.headers.host || "");
    if (!run.port || (host !== `127.0.0.1:${run.port}` && host !== `localhost:${run.port}`)) {
      return send(res, 403, { error: "forbidden" });
    }
    if (req.method !== "POST" || req.url !== "/ask") return send(res, 404, { error: "not found" });
    const auth = String(req.headers.authorization || "");
    if (!tokensMatch(auth.replace(/^Bearer /, ""), run.token)) {
      return send(res, 401, { error: "unauthorized" });
    }

    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        send(res, 413, { error: "too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return send(res, 400, { error: "the body must be JSON" });
      }
      const { value, error } = readQuestion(body);
      if (error) return send(res, 400, { error });
      void this._answer(value, res);
    });
  }

  async _answer(question, res) {
    const controller = new AbortController();
    // The bridge gave up (its own limit, or the chat was interrupted): so does the question.
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ answer: null, reason: "no_answer" });
      }, ANSWER_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      const result = await Promise.race([
        this.ask(question, { signal: controller.signal }),
        timeout,
      ]);
      send(res, 200, result);
    } catch (error) {
      this.log("Narrator could not ask by voice", { error: error.message });
      send(res, 200, { answer: null, reason: "not_active" });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The name Claude Code lists the server under; tools appear as mcp__privatetranscribe__*. */
const SERVER_NAME = "privatetranscribe";

/**
 * A Windows path as PowerShell writes it, with the user's own folders as
 * variables: the line is then the same on every PC and shows no user name.
 */
function powershellPath(file, vars) {
  const resolved = path.win32.resolve(file);
  for (const name of ["LOCALAPPDATA", "APPDATA", "ProgramFiles"]) {
    if (!vars[name]) continue;
    const base = path.win32.resolve(vars[name]);
    const lower = resolved.toLowerCase();
    if (lower === base.toLowerCase() || lower.startsWith(`${base.toLowerCase()}\\`)) {
      return `$env:${name}${resolved.slice(base.length)}`;
    }
  }
  return resolved;
}

/**
 * The one line that connects Claude Code to ask_by_voice, for the Narrator
 * page to copy, written for PowerShell on Windows. An installed app runs the
 * bridge with its own runtime, so no Node install is needed. A development
 * copy runs it with node, which keeps the line working when the copy moves.
 * The server's name comes before --env, which takes every word up to the
 * next option, so `--env X=1 name` would read the name as a second variable.
 */
function askCommand({
  userData,
  execPath = process.execPath,
  packaged = false,
  platform = process.platform,
  vars = process.env,
}) {
  const windows = platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  const quote = (file) =>
    windows ? `"${powershellPath(file, vars)}"` : `'${String(file).replace(/'/g, "'\\''")}'`;
  const bridge = quote(paths.join(userData, BRIDGE_FILE));
  const run = packaged
    ? `${SERVER_NAME} --env ELECTRON_RUN_AS_NODE=1 -- ${quote(execPath)}`
    : `${SERVER_NAME} -- node`;
  return `claude mcp add --scope user ${run} ${bridge}`;
}

module.exports = {
  NarratorAskServer,
  readQuestion,
  askCommand,
  ADDRESS_FILE,
  BRIDGE_FILE,
  LIMITS,
  SERVER_NAME,
};
