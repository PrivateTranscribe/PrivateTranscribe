/**
 * A stand-in for the `claude` CLI, for the barge-in e2e gate.
 *
 * The gate has to prove two things about a REAL agent process: that an injected
 * interrupt stops speech fast, and that the next outbound prompt written to that
 * process's stdin carries the heard / cut-off / never-spoken wrapper. Both need
 * a live child process on the other end of the pipe — but neither needs a real
 * model, and a real one would make the answer (and therefore the sentence that
 * gets cut) different on every run. So this script speaks the CLI's stream-json
 * protocol with a scripted answer.
 *
 * It is NOT mock mode: the app runs its live path end to end — spawn, stdin
 * stream-json writes, stdout event parsing, turn accounting. Only the model is
 * replaced.
 *
 * Wiring (see converseAgent.js):
 *   PT_CONVERSE_CLAUDE_BIN  = path to node
 *   PT_CONVERSE_CLAUDE_ARGS = ["<this file>"]
 *
 * Environment:
 *   CLAUDE_STUB_LOG          file every received stdin line is appended to,
 *                            verbatim, one line per line, flushed synchronously.
 *                            This file is the gate's evidence: it is what the
 *                            app actually sent, not what the app says it sent.
 *   CLAUDE_STUB_LONG_MARKER  substring that selects the long answer
 *                            (default "everything").
 *   CLAUDE_STUB_DELAY_MS     milliseconds to wait before the FIRST delta of a
 *                            reply (default 0, i.e. unchanged). A real model
 *                            thinks for a second or two before it says
 *                            anything; with the default the app leaves
 *                            "thinking" almost immediately, which is too fast
 *                            to photograph. Only the first delta is delayed —
 *                            streaming speed afterwards is untouched.
 *   CLAUDE_STUB_DELTA_GAP_MS gap between text deltas (default 5). Raising it
 *                            makes the answer arrive slowly enough that a UI
 *                            can be caught rendering a half-finished reply.
 *   CLAUDE_STUB_STATE        directory holding one JSON file per session id.
 *                            This is the stub's memory: it is what makes
 *                            `--resume <id>` observable, because a resumed
 *                            process can answer from a file the previous
 *                            process wrote. Unset means no memory at all.
 *
 * Permission questions (see "asking permission" below):
 *   CLAUDE_STUB_PERMISSION_MARKER  substring of a prompt that makes the stub
 *                                  ask for permission before answering
 *                                  (default "ask permission").
 *   CLAUDE_STUB_PERMISSION_TOOL    tool name to ask about (default "Write").
 *   CLAUDE_STUB_PERMISSION_INPUT   JSON object used as the tool input.
 *   CLAUDE_STUB_PERMISSION_COUNT   how many questions to ask at once
 *                                  (default 1). More than one is how a queue
 *                                  of pending prompts gets tested.
 *   CLAUDE_STUB_PERMISSION_RESULT  file the decisions are written to as JSON.
 *                                  This is the evidence: it is what the relay
 *                                  actually resolved the MCP call with, not
 *                                  what any UI claims happened.
 *
 * Session identity: the stub announces a fresh uuid in its init line, unless it
 * was started with `--resume <id>`, in which case it adopts that id and loads
 * the memory filed under it. The remembered word is whatever the caller asked
 * it to remember — the stub knows no specific word, so a test's nonce lives
 * only in the test.
 */

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const LOG_PATH = process.env.CLAUDE_STUB_LOG || "";
const LONG_MARKER = process.env.CLAUDE_STUB_LONG_MARKER || "everything";
const STATE_DIR = process.env.CLAUDE_STUB_STATE || "";
const FIRST_DELTA_DELAY_MS = Math.max(0, Number(process.env.CLAUDE_STUB_DELAY_MS) || 0);

/** `--resume <id>` anywhere in argv, mirroring how the CLI accepts it. */
function resumeIdFromArgv(argv) {
  const at = argv.indexOf("--resume");
  if (at >= 0 && argv[at + 1] && !argv[at + 1].startsWith("--")) return argv[at + 1];
  const inline = argv.find((arg) => arg.startsWith("--resume="));
  return inline ? inline.slice("--resume=".length) : null;
}

const RESUMED_FROM = resumeIdFromArgv(process.argv.slice(2));
const SESSION_ID = RESUMED_FROM || crypto.randomUUID();

const statePath = () => (STATE_DIR ? path.join(STATE_DIR, `${SESSION_ID}.json`) : "");

/** Everything this session has been told, as of the last write. */
function loadState() {
  const file = statePath();
  if (!file) return { sessionId: SESSION_ID, texts: [], word: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      sessionId: SESSION_ID,
      texts: Array.isArray(parsed.texts) ? parsed.texts : [],
      word: typeof parsed.word === "string" ? parsed.word : null,
    };
  } catch {
    return { sessionId: SESSION_ID, texts: [], word: null };
  }
}

function saveState(state) {
  const file = statePath();
  if (!file) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // A stub that cannot remember still has to answer; the assertion will fail
    // loudly on the reply rather than quietly here.
  }
}

const state = loadState();

/**
 * Eight sentences, each ending in a period followed by a space, so the app's
 * incremental splitter yields exactly eight sentences with stable indices. The
 * numbered word makes "which sentence was cut" unambiguous in the assertion.
 */
const LONG_SENTENCES = [
  "Stub sentence one.",
  "Stub sentence two.",
  "Stub sentence three.",
  "Stub sentence four.",
  "Stub sentence five.",
  "Stub sentence six.",
  "Stub sentence seven.",
  "Stub sentence eight.",
];

/** Anything that is not a request for the long answer gets one sentence. */
const SHORT_SENTENCES = ["Stub short acknowledgement only."];

/** Gap between text deltas. Small by default on purpose: the answer should be
 * fully streamed long before playback catches up, so the interrupt lands
 * mid-speech rather than mid-generation. CLAUDE_STUB_DELTA_GAP_MS slows it
 * down for the one case that needs the opposite — proving a UI renders the
 * reply while it is still arriving, which is unobservable at 5ms. */
const DELTA_GAP_MS = Math.max(0, Number(process.env.CLAUDE_STUB_DELTA_GAP_MS) || 5);

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function emitDelta(text) {
  emit({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
  });
}

/** Append one received line exactly as received, flushed before returning. */
function logRawLine(line) {
  if (!LOG_PATH) return;
  const fd = fs.openSync(LOG_PATH, "a");
  try {
    fs.writeSync(fd, `${line}\n`);
    try {
      fs.fsyncSync(fd);
    } catch {
      // Some filesystems refuse fsync on an append handle; the writeSync above
      // has already handed the bytes to the OS, which is enough for a reader
      // in another process.
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Text of a stream-json user message, tolerating both content shapes. */
function userText(message) {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text")
    .map((part) => part.text)
    .join(" ");
}

/** "remember the word grobblewurst" -> "grobblewurst". Generic on purpose. */
const REMEMBER_RE = /remember the word[:\s]+["'`]?([\p{L}\p{N}][\p{L}\p{N}'-]*)/iu;

/**
 * What this session says back. Memory beats nothing, but the long-answer marker
 * still wins outright, so the barge-in spec's eight sentences are unaffected.
 */
function sentencesFor(prompt) {
  if (prompt.includes(LONG_MARKER)) return LONG_SENTENCES;

  const remember = prompt.match(REMEMBER_RE);
  if (remember) {
    state.word = remember[1];
    saveState(state);
    return [`Noted. I will remember the word ${state.word}.`];
  }

  if (/\bthe word\b/i.test(prompt)) {
    return state.word
      ? [`The word you asked me to remember is ${state.word}.`]
      : ["I do not know the word."];
  }

  return SHORT_SENTENCES;
}

// ------------------------------------------------------- asking permission
//
// The real CLI does not decide permissions itself: when it is started with
// `--permission-prompt-tool mcp__pt-permissions__approve --mcp-config <file>`
// it spawns the server named in that file and calls the tool. This stub does
// exactly that — reads the config the app wrote, spawns the app's REAL
// conversePermissionMcp.cjs with the port and token the app put there, and
// speaks MCP JSON-RPC to it. Nothing about the relay, the transport, or the
// fail-closed contract is stubbed; only the model is.

const PERMISSION_MARKER = process.env.CLAUDE_STUB_PERMISSION_MARKER || "ask permission";
const PERMISSION_TOOL = process.env.CLAUDE_STUB_PERMISSION_TOOL || "Write";
const PERMISSION_COUNT = Math.max(1, Number(process.env.CLAUDE_STUB_PERMISSION_COUNT) || 1);
const PERMISSION_RESULT = process.env.CLAUDE_STUB_PERMISSION_RESULT || "";

function permissionInput(index) {
  let base = { file_path: "notes/config.json", content: "hello from the stub" };
  if (process.env.CLAUDE_STUB_PERMISSION_INPUT) {
    try {
      base = JSON.parse(process.env.CLAUDE_STUB_PERMISSION_INPUT);
    } catch {
      // Keep the default rather than failing the spawn; the assertion on the
      // rendered input will say what went wrong.
    }
  }
  if (PERMISSION_COUNT === 1) return base;
  // Distinct inputs so a queue of prompts is distinguishable on screen.
  const suffixed = { ...base };
  if (typeof suffixed.file_path === "string") {
    suffixed.file_path = suffixed.file_path.replace(/(\.[^.]+)?$/, `-${index + 1}$1`);
  }
  return suffixed;
}

/** `--mcp-config <path>` as converseAgent.js passes it. */
function mcpConfigFromArgv(argv) {
  const at = argv.indexOf("--mcp-config");
  const file = at >= 0 ? argv[at + 1] : null;
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The permission MCP server, spawned the way the CLI would spawn it. */
function startPermissionMcp() {
  const config = mcpConfigFromArgv(process.argv.slice(2));
  const server = config && config.mcpServers && config.mcpServers["pt-permissions"];
  if (!server) return null;

  const child = spawn(server.command, server.args || [], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, ...(server.env || {}) },
  });

  const pending = new Map();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  return {
    child,
    request,
    notify: (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`),
  };
}

/** The decision the MCP reply carries, in the CLI's own result shape. */
function decisionOf(reply) {
  try {
    return JSON.parse(reply.result.content[0].text);
  } catch {
    return { behavior: "deny", message: "unreadable MCP reply" };
  }
}

async function askPermissions() {
  const mcp = startPermissionMcp();
  if (!mcp) return [{ behavior: "deny", message: "no permission MCP server configured" }];

  try {
    await mcp.request("initialize", { protocolVersion: "2024-11-05" });
    mcp.notify("notifications/initialized");

    // All of them in flight at once, so the app really does have to hold more
    // than one question open at a time.
    const replies = await Promise.all(
      Array.from({ length: PERMISSION_COUNT }, (_, index) =>
        mcp.request("tools/call", {
          name: "approve",
          arguments: {
            tool_name: PERMISSION_TOOL,
            input: permissionInput(index),
            tool_use_id: `stub_tu_${index + 1}`,
          },
        })
      )
    );
    return replies.map(decisionOf);
  } finally {
    mcp.child.kill();
  }
}

function reply(prompt) {
  state.texts.push(prompt);

  if (prompt.includes(PERMISSION_MARKER)) {
    askPermissions().then((decisions) => {
      if (PERMISSION_RESULT) {
        try {
          fs.writeFileSync(PERMISSION_RESULT, JSON.stringify(decisions, null, 2), "utf8");
        } catch {
          // The spoken sentences below still carry the decision.
        }
      }
      streamSentences(
        decisions.map((decision, index) => `Permission ${index + 1} came back ${decision.behavior}.`)
      );
    });
    return;
  }

  streamSentences(sentencesFor(prompt));
}

function streamSentences(sentences) {
  saveState(state);
  const startedAt = Date.now();

  // Two deltas per sentence, so the splitter has to accumulate rather than
  // receive whole sentences. Every sentence ends with a trailing space, so all
  // of them are produced by push() and none depend on the end-of-turn flush.
  const chunks = [];
  for (const sentence of sentences) {
    const cut = sentence.indexOf(" ", Math.floor(sentence.length / 2));
    const split = cut > 0 ? cut + 1 : sentence.length;
    chunks.push(sentence.slice(0, split));
    chunks.push(`${sentence.slice(split)} `);
  }

  let i = 0;
  const step = () => {
    if (i < chunks.length) {
      emitDelta(chunks[i]);
      i += 1;
      setTimeout(step, DELTA_GAP_MS);
      return;
    }
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: Date.now() - startedAt,
      result: sentences.join(" "),
      session_id: SESSION_ID,
    });
  };

  // The pause is before the first delta only, so a spec can catch "thinking"
  // on screen without changing how the answer streams once it starts.
  if (FIRST_DELTA_DELAY_MS > 0) setTimeout(step, FIRST_DELTA_DELAY_MS);
  else step();
}

// Same shape as the real CLI's init line: a top-level `session_id` on a
// `system`/`init` event. The app reads the id off this line.
emit({
  type: "system",
  subtype: "init",
  session_id: SESSION_ID,
  model: "claude-stub",
  resumed_from: RESUMED_FROM,
});

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    logRawLine(line);

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event && event.type === "user") reply(userText(event.message));
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
