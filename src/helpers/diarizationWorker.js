#!/usr/bin/env node
// Runs one diarization outside the main process for diarizeWavFileInWorker.
// The app starts it as its own executable with ELECTRON_RUN_AS_NODE=1, and an
// installed build ships no electron package for require("electron") to find.
// So this file loads diarizationEngine.js, never diarizationManager.js, and
// logs through the console instead of debugLogger: both of those import
// Electron. tests/unit/helpers/diarizationWorker.test.ts holds the line.
const fs = require("fs");
const { format } = require("util");

const resultStdout = process.stdout.write.bind(process.stdout);
const stderrWrite = process.stderr.write.bind(process.stderr);

// Keep stdout machine-readable for the parent process: every log line,
// including the engine's own, goes to stderr.
const writeLog = (...args) => stderrWrite(`${format(...args)}\n`);
console.log = writeLog;
console.info = writeLog;
console.warn = writeLog;
console.error = writeLog;

const { DiarizationEngine } = require("./diarizationEngine");

async function main() {
  const payloadPath = process.argv[2];
  if (!payloadPath) {
    throw new Error("Missing diarization worker payload path.");
  }

  const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
  const engine = new DiarizationEngine(payload.engineOptions || {});
  const result = await engine.diarizeWavFile(payload.wavPath, payload.options || {});
  resultStdout(JSON.stringify({ success: true, result }));
}

main().catch((error) => {
  resultStdout(
    JSON.stringify({
      success: false,
      error: error?.message || String(error),
      stack: error?.stack || null,
    })
  );
  process.exitCode = 1;
});
