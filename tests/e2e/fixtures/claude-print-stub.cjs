/**
 * A stand-in for `claude --print --output-format json`, for the Agent Mode e2e.
 *
 * The app spawns the real CLI once per Agent Mode prompt and reads one JSON
 * object back (see src/helpers/agentPromptRewriter.js). A live run would spend
 * the developer's Claude subscription and answer differently every time, so
 * this script plays the CLI's part: it drains stdin, records what it was asked,
 * and prints a fixed reply in the CLI's result shape.
 *
 * Wiring (the same two variables converseAgent.js reads):
 *   PT_CONVERSE_CLAUDE_BIN  = path to node
 *   PT_CONVERSE_CLAUDE_ARGS = ["<this file>"]
 *
 * Environment:
 *   CLAUDE_PRINT_STUB_LOG    file one JSON line per call is appended to:
 *                            { argv, stdin } — the evidence of what the app sent.
 *   CLAUDE_PRINT_STUB_REPLY  the `result` text to print (default below).
 *   CLAUDE_PRINT_STUB_EXIT   exit with this code and no JSON, to play a failure.
 *   CLAUDE_PRINT_STUB_DELAY_MS wait this long before answering, so the overlay's
 *                            rewriting state lasts long enough to photograph.
 */
"use strict";

const fs = require("node:fs");

const DEFAULT_REPLY =
  "Fix the crash when the login form is submitted empty. " +
  "It is in `auth/login.ts`, the `validate` function. Fix it and add a test.";

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  const delayMs = Number(process.env.CLAUDE_PRINT_STUB_DELAY_MS || "0");
  setTimeout(answer, Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0);
});

function answer() {
  if (process.env.CLAUDE_PRINT_STUB_LOG) {
    fs.appendFileSync(
      process.env.CLAUDE_PRINT_STUB_LOG,
      JSON.stringify({ argv: process.argv.slice(2), stdin }) + "\n"
    );
  }
  const exitCode = Number(process.env.CLAUDE_PRINT_STUB_EXIT || "0");
  if (exitCode !== 0) {
    process.stderr.write("stubbed failure\n");
    process.exit(exitCode);
  }
  const reply = process.env.CLAUDE_PRINT_STUB_REPLY || DEFAULT_REPLY;
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 2200,
      duration_api_ms: 1180,
      num_turns: 1,
      result: reply,
      session_id: "stub",
      total_cost_usd: 0,
      usage: { input_tokens: 507, output_tokens: 31 },
    }) + "\n"
  );
}
