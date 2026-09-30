/**
 * Relay for the harness's own permission questions (Converse).
 *
 * Settled product decision: the app adds NO permission rules
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

/**
 * Test-only override of the deny timeout, in milliseconds
 * (`PT_CONVERSE_PERMISSION_TIMEOUT_MS`).
 *
 * The auto-deny path is the one a user never sees on purpose — they walked
 * away — so the only way to prove the UI resolves a card to the auto-denied
 * record is to make the timeout short enough to sit through in a test. It can
 * only ever shorten or lengthen the fail-closed timer; there is no value that
 * disables it, and nothing here can turn a timeout into an allow.
 */
function resolveAnswerTimeoutMs() {
  const raw = Number(process.env.PT_CONVERSE_PERMISSION_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : ANSWER_TIMEOUT_MS;
}

class ConversePermissionRelay {
  constructor({ onRequest, timeoutMs } = {}) {
    /** Notified when a question arrives, so the UI/voice layer can prompt. */
    this.onRequest = onRequest || (() => {});
    /**
     * How long one question may go unanswered before it denies itself. Read
     * once here rather than per question, so a session's countdown cannot move
     * under the user mid-question.
     */
    this.timeoutMs =
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : resolveAnswerTimeoutMs();
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
      this.answer(id, { behavior: "deny", message: "relay stopped", by: "session-stopped" });
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

  /**
   * Resolve one pending question. Returns false if it was not waiting.
   *
   * `by` records WHO decided — "user" (someone clicked), "auto" (a standing
   * answer armed up front), "timeout" (nobody answered), "session-stopped".
   * The UI needs it to tell "you denied this" from "this denied itself while
   * you were away", and only the relay knows which happened.
   */
  answer(id, { behavior, message, by = "user" } = {}) {
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
      logged.answeredBy = by;
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
      const at = Date.now();
      const entry = {
        id,
        at,
        tool_name: String(parsed.tool_name ?? ""),
        input: parsed.input ?? null,
        tool_use_id: parsed.tool_use_id ?? null,
        answeredWith: null,
        answeredAt: null,
        answeredBy: null,
        // The moment this question denies itself, as an absolute timestamp.
        // The UI counts down to it rather than starting its own timer, so a
        // renderer that was asleep, throttled, or opened late still shows the
        // real remaining time instead of a fresh 55 seconds.
        timeoutMs: this.timeoutMs,
        deadline: at + this.timeoutMs,
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
        this.answer(id, {
          behavior: "deny",
          message: "no answer before timeout",
          by: "timeout",
        });
      }, this.timeoutMs);

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
          by: "auto",
        });
      }
    });
  }
}

module.exports = { ConversePermissionRelay, ANSWER_TIMEOUT_MS, resolveAnswerTimeoutMs };
