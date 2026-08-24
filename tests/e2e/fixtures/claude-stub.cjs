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
 */

const fs = require("node:fs");

const LOG_PATH = process.env.CLAUDE_STUB_LOG || "";
const LONG_MARKER = process.env.CLAUDE_STUB_LONG_MARKER || "everything";

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

/** Gap between text deltas. Small on purpose: the answer should be fully
 * streamed long before playback catches up, so the interrupt lands mid-speech
 * rather than mid-generation. */
const DELTA_GAP_MS = 5;

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

function reply(prompt) {
  const sentences = prompt.includes(LONG_MARKER) ? LONG_SENTENCES : SHORT_SENTENCES;
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
      session_id: "stub-session",
    });
  };
  step();
}

emit({
  type: "system",
  subtype: "init",
  session_id: "stub-session",
  model: "claude-stub",
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
