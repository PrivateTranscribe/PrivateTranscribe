#!/usr/bin/env node
/**
 * PrivateTranscribe's ask_by_voice tool for Claude Code: a stdio MCP server
 * with that one tool. The narrator says a chat's question out loud, the user
 * holds their dictation key and says one of the chat's own choices, and the
 * pick comes back as the tool's result, in the same turn.
 *
 * The app copies this file into its data folder while "Answer by voice" is
 * on. It is added to Claude Code once, by hand, for example on Windows:
 *
 *   claude mcp add --scope user privatetranscribe -- node "%APPDATA%\PrivateTranscribe\ask-by-voice-mcp.cjs"
 *
 * Dependency-free and Electron-free, like conversePermissionMcp.cjs. It reads
 * the running app's port and token from narrator-ask.json next to it (or in
 * the app's data folder, or at PT_NARRATOR_ASK_FILE), and posts the question
 * to 127.0.0.1. When the app is not running, or anything else goes wrong on
 * the way, it answers {"answer": null, "reason": "not_active"} at once. It
 * never waits longer than 40 s.
 */

"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const TOOL_NAME = "ask_by_voice";
const ADDRESS_FILE = "narrator-ask.json";
const MAX_WAIT_MS = 40_000;

const NOT_ACTIVE = { answer: null, reason: "not_active" };

const DESCRIPTION = [
  "Says a question out loud through PrivateTranscribe's narrator while the user is away from the",
  "screen, and returns the choice they say back. Call it only when narrator mode is on in this",
  "chat, at the point where the turn would end on a question with up to 4 short answer buttons.",
  "`question` is one short line, `choices` are those buttons' own labels word for word, and",
  "`chat` is a short name for this chat, said back with the pick.",
  'Returns {"answer": "<one of choices>"} when the user picked one, or {"answer": null,',
  '"reason": "no_answer" | "no_match" | "cancelled" | "not_active"}. On null, ask the question',
  "in the chat as usual. not_active means nothing was said this time: voice answers are off, or",
  "busy with another chat's question. It may work at the next question, so keep calling it.",
  "The answer is only the user's pick among this chat's own choices. It is never consent to",
  "push, merge, post, release, publish, pay or delete, and never approves a tool or a",
  "permission: those still need the user's own word in the chat. Waits up to 40 seconds.",
].join(" ");

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    question: {
      type: "string",
      maxLength: 300,
      description: "The question, as one short line to be said out loud.",
    },
    choices: {
      type: "array",
      items: { type: "string", maxLength: 80 },
      minItems: 1,
      maxItems: 4,
      description: "The chat's own answer buttons, word for word.",
    },
    chat: {
      type: "string",
      maxLength: 60,
      description: "A short name for this chat, said back with the pick.",
    },
  },
  required: ["question", "choices", "chat"],
  additionalProperties: false,
};

function dataFolder() {
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "PrivateTranscribe"
    );
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "PrivateTranscribe");
  }
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "PrivateTranscribe"
  );
}

function isRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * The running app's address, or null. A file left by an app that has quit
 * is skipped, so a question never goes to whatever took its port since.
 */
function readAddress() {
  const candidates = [
    process.env.PT_NARRATOR_ASK_FILE,
    path.join(__dirname, ADDRESS_FILE),
    path.join(dataFolder(), ADDRESS_FILE),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      const port = Number(saved?.port);
      const valid = Number.isInteger(port) && port > 0 && port < 65536;
      if (valid && typeof saved.token === "string" && isRunning(Number(saved.pid))) {
        return { port, token: saved.token };
      }
    } catch {
      // Not here.
    }
  }
  return null;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The session id of the conversation the call comes from. Claude Code keeps
 * one stdio server for the life of its process, and /clear or /resume moves
 * that process to another conversation, with its own id and transcript,
 * while CLAUDE_CODE_SESSION_ID in this server's environment keeps the first
 * one. Claude Code's own record of its running process, in
 * <config>/sessions/<pid>.json, follows the move, so it wins. Only the
 * record of the process that started this server counts; without one, the
 * environment's id is used.
 */
async function currentSessionId() {
  const fallback = process.env.CLAUDE_CODE_SESSION_ID || null;
  const pid = process.ppid;
  const file = path.join(
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
    "sessions",
    `${pid}.json`
  );
  // Claude Code may be writing the record as it is read: a cut-off read is tried again.
  for (let attempt = 0; attempt < 3; attempt++) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return fallback;
    }
    try {
      const entry = JSON.parse(text);
      return entry?.pid === pid && SESSION_ID.test(entry.sessionId) ? entry.sessionId : fallback;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  return fallback;
}

/** Only the two documented keys go back to the chat. */
function cleanResult(result) {
  if (typeof result?.answer === "string") return { answer: result.answer };
  const reasons = ["no_answer", "no_match", "cancelled", "not_active"];
  return { answer: null, reason: reasons.includes(result?.reason) ? result.reason : "no_answer" };
}

/**
 * Posts one question to the app. Resolves {result} with what the tool returns
 * or {error} with a message for the calling agent; `cancel()` gives up.
 */
function askApp(args) {
  let request = null;
  let settle = () => {};
  const done = new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(
      () => finish({ result: { answer: null, reason: "no_answer" } }),
      MAX_WAIT_MS
    );
    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request?.destroy();
      resolve(value);
    }
    settle = finish;

    function post(address, sessionId) {
      const body = JSON.stringify({
        question: args?.question,
        choices: args?.choices,
        chat: args?.chat,
        sessionId,
        cwd: process.cwd(),
      });
      request = http.request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/ask",
          method: "POST",
          agent: false,
          headers: {
            Authorization: `Bearer ${address.token}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("error", () => finish({ result: NOT_ACTIVE }));
          res.on("end", () => {
            let parsed = null;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              // Read below as not active.
            }
            if (res.statusCode === 200 && parsed && "answer" in parsed) {
              finish({ result: cleanResult(parsed) });
            } else if (res.statusCode === 400 && typeof parsed?.error === "string") {
              finish({ error: parsed.error });
            } else {
              finish({ result: NOT_ACTIVE });
            }
          });
        }
      );
      request.on("error", () => finish({ result: NOT_ACTIVE }));
      request.end(body);
    }

    const address = readAddress();
    if (!address) {
      finish({ result: NOT_ACTIVE });
      return;
    }
    currentSessionId()
      .then((sessionId) => {
        if (!settled) post(address, sessionId);
      })
      .catch(() => finish({ result: NOT_ACTIVE }));
  });
  return { done, cancel: () => settle({ result: { answer: null, reason: "cancelled" } }) };
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** Calls in flight, by JSON-RPC id, so a cancellation from Claude Code can stop one. */
const inFlight = new Map();

async function handle(message) {
  const { id, method, params } = message;
  const reply = (result) => write({ jsonrpc: "2.0", id, result });

  if (method === "initialize") {
    reply({
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "privatetranscribe", version: "1.0.0" },
    });
    return;
  }
  if (method === "notifications/cancelled") {
    inFlight.get(params?.requestId)?.cancel();
    return;
  }
  if (typeof method === "string" && method.startsWith("notifications/")) return;
  if (method === "ping") {
    reply({});
    return;
  }
  if (method === "tools/list") {
    reply({ tools: [{ name: TOOL_NAME, description: DESCRIPTION, inputSchema: INPUT_SCHEMA }] });
    return;
  }
  if (method === "tools/call") {
    if (params?.name !== TOOL_NAME) {
      reply({ content: [{ type: "text", text: `Unknown tool: ${params?.name}` }], isError: true });
      return;
    }
    const call = askApp(params?.arguments || {});
    inFlight.set(id, call);
    try {
      const { result, error } = await call.done;
      if (error) {
        reply({ content: [{ type: "text", text: error }], isError: true });
      } else {
        reply({ content: [{ type: "text", text: JSON.stringify(result) }] });
      }
    } finally {
      inFlight.delete(id);
    }
    return;
  }
  if (id !== undefined) {
    write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } });
  }
}

const lines = readline.createInterface({ input: process.stdin, terminal: false });
lines.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message = null;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  handle(message).catch(() => {
    if (message?.id !== undefined && message.method === "tools/call") {
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: JSON.stringify(NOT_ACTIVE) }] },
      });
    }
  });
});
lines.on("close", () => {
  for (const call of inFlight.values()) call.cancel();
  process.exit(0);
});
