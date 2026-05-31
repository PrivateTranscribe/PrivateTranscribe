#!/usr/bin/env node
const fs = require("fs");

const resultStdout = process.stdout.write.bind(process.stdout);
const stderrWrite = process.stderr.write.bind(process.stderr);

// Keep stdout machine-readable for the parent process. debugLogger writes to
// console by default, so route normal logging to stderr inside the worker.
console.log = (...args) => stderrWrite(`${args.map(String).join(" ")}\n`);
console.warn = (...args) => stderrWrite(`${args.map(String).join(" ")}\n`);
console.error = (...args) => stderrWrite(`${args.map(String).join(" ")}\n`);

const { DiarizationManager } = require("./diarizationManager");

async function main() {
  const payloadPath = process.argv[2];
  if (!payloadPath) {
    throw new Error("Missing diarization worker payload path.");
  }

  const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
  const manager = new DiarizationManager(payload.managerOptions || {});
  const result = await manager.diarizeWavFile(payload.wavPath, payload.options || {});
  resultStdout(JSON.stringify({ success: true, result }));
}

main().catch((error) => {
  resultStdout(JSON.stringify({
    success: false,
    error: error?.message || String(error),
    stack: error?.stack || null,
  }));
  process.exitCode = 1;
});
