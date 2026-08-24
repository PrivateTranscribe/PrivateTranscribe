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
 *   CLAUDE_STUB_STATE        directory holding one JSON file per session id.
 *                            This is the stub's memory: it is what makes
 *                            `--resume <id>` observable, because a resumed
 *                            process can answer from a file the previous
 *                            process wrote. Unset means no memory at all.
 *
 * Session identity: the stub announces a fresh uuid in its init line, unless it
 * was started with `--resume <id>`, in which case it adopts that id and loads
 * the memory filed under it. The remembered word is whatever the caller asked
 * it to remember — the stub knows no specific word, so a test's nonce lives
 * only in the test.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const LOG_PATH = process.env.CLAUDE_STUB_LOG || "";
const LONG_MARKER = process.env.CLAUDE_STUB_LONG_MARKER || "everything";
const STATE_DIR = process.env.CLAUDE_STUB_STATE || "";

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

function reply(prompt) {
  state.texts.push(prompt);
  const sentences = sentencesFor(prompt);
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
  step();
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
