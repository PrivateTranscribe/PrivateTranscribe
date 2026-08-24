/**
 * Relay for the harness's own permission questions (Converse).
 *
 * Settled product decision (docs/GOALS.md): the app adds NO permission rules
 * of its own. When the `claude` process wants to use a tool that its own
 * settings do not already allow, it asks through `--permission-prompt-tool`,
 * an MCP tool served by conversePermissionMcp.cjs. That script forwards the
 * question here over loopback HTTP, and this relay holds it open until the
 * user answers (by voice or UI later; tests inject the answer the way a user
 * would click).
 *
 * FAIL CLOSED, always: a timeout, a malformed request, a missing answer — all
 * resolve to deny. There is no configuration that makes this default-allow,
 * and nothing here ever passes a bypass flag to the CLI.
 */

const crypto = require("node:crypto");
const http = require("node:http");

/** An unanswered question denies itself after this long. */
const ANSWER_TIMEOUT_MS = 55_000;
const LOG_LIMIT = 100;

class ConversePermissionRelay {
  constructor({ onRequest } = {}) {
    /** Notified when a question arrives, so the UI/voice layer can prompt. */
    this.onRequest = onRequest || (() => {});
    this.server = null;
    this.port = 0;
    this.token = crypto.randomBytes(16).toString("hex");
    /** id -> { resolve } for questions still waiting on an answer. */
    this.pending = new Map();
    this.log = [];
    /**
     * A standing answer armed before the question arrives. Deterministic tests
     * (and a future "always ask" voice flow) need the answer decided up front;
     * null means every question waits for an explicit answer() call.
     */
    this.autoAnswer = null;
    this.nextId = 1;
  }

  start() {
    if (this.server) return Promise.resolve({ port: this.port, token: this.token });
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handle(req, res));
      this.server.on("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.port = this.server.address().port;
        resolve({ port: this.port, token: this.token });
      });
    });
  }

  stop() {
    if (!this.server) return;
    // Anything still waiting dies denied, not dangling.
    for (const [id] of this.pending)
      this.answer(id, { behavior: "deny", message: "relay stopped" });
    this.server.close();
    this.server = null;
  }

  getLog() {
    return this.log.slice();
  }

  setAutoAnswer(behavior) {
    this.autoAnswer = behavior === "allow" || behavior === "deny" ? behavior : null;
    return this.autoAnswer;
  }

  /** Resolve one pending question. Returns false if it was not waiting. */
  answer(id, { behavior, message } = {}) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    const safeBehavior = behavior === "allow" ? "allow" : "deny";
    entry.resolve({ behavior: safeBehavior, message: message || "" });
    const logged = this.log.find((line) => line.id === id);
    if (logged) {
      logged.answeredWith = safeBehavior;
      logged.answeredAt = Date.now();
    }
    return true;
  }

  _handle(req, res) {
    if (req.method !== "POST" || req.url !== "/permission") {
      res.writeHead(404).end();
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        // Malformed question: deny, do not guess.
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ behavior: "deny", message: "malformed permission request" }));
        return;
      }

      if (!parsed || parsed.token !== this.token) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ behavior: "deny", message: "bad relay token" }));
        return;
      }

      const id = this.nextId++;
      const entry = {
        id,
        at: Date.now(),
        tool_name: String(parsed.tool_name ?? ""),
        input: parsed.input ?? null,
        tool_use_id: parsed.tool_use_id ?? null,
        answeredWith: null,
        answeredAt: null,
      };
      this.log.push(entry);
      if (this.log.length > LOG_LIMIT) this.log.shift();

      const finish = (decision) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(decision));
      };

      const timer = setTimeout(() => {
        // Nobody answered in time. Deny — a stuck question must never turn
        // into a granted permission.
        this.answer(id, { behavior: "deny", message: "no answer before timeout" });
      }, ANSWER_TIMEOUT_MS);

      this.pending.set(id, { resolve: finish, timer });

      try {
        this.onRequest(entry);
      } catch {
        // A broken notification hook must not break the question itself.
      }

      if (this.autoAnswer) {
        this.answer(id, {
          behavior: this.autoAnswer,
          message: this.autoAnswer === "deny" ? "denied by user" : "",
        });
      }
    });
  }
}

module.exports = { ConversePermissionRelay, ANSWER_TIMEOUT_MS };
