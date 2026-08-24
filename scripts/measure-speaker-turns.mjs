#!/usr/bin/env node
/**
 * measure-speaker-turns.mjs
 *
 * Runs the app's own tinydiarize path (WhisperServerManager, forced CPU,
 * ggml-small.en-tdrz.bin) over the frozen multispeaker fixture and reports how
 * many TRUE speaker-turn boundaries have a predicted [SPEAKER_TURN] marker
 * within a tolerance window.
 *
 * It measures. It does not judge: no threshold lives here. The ledger gate
 * (transcribe-speaker-turns) compares the printed number to its bar.
 *
 * Ground truth: tests/fixtures/multispeaker/interview.truth.json. A true
 * boundary is every utterance transition where the speaker changes; its time
 * is the END of the earlier utterance (the moment the voice stops). A
 * predicted marker's time is the end of the segment whisper flagged with
 * [SPEAKER_TURN].
 *
 * Usage:
 *   node scripts/measure-speaker-turns.mjs
 *   node scripts/measure-speaker-turns.mjs --tolerance 2 --model <path> --transcript
 */

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const WhisperServerManager = require("../src/helpers/whisperServer.js");

const DEFAULT_WAV = path.join(REPO_ROOT, "tests", "fixtures", "multispeaker", "interview.wav");
const DEFAULT_MODEL = path.join(
  os.homedir(),
  ".cache",
  "PrivateTranscribe",
  "whisper-models",
  "ggml-small.en-tdrz.bin"
);

function parseArgs(argv) {
  const args = {
    wav: DEFAULT_WAV,
    truth: null,
    model: DEFAULT_MODEL,
    tolerance: 2,
    transcript: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--wav" && value) ((args.wav = path.resolve(value)), (i += 1));
    else if (flag === "--truth" && value) ((args.truth = path.resolve(value)), (i += 1));
    else if (flag === "--model" && value) ((args.model = path.resolve(value)), (i += 1));
    else if (flag === "--tolerance" && value) ((args.tolerance = Number(value)), (i += 1));
    else if (flag === "--transcript") args.transcript = true;
  }
  if (!args.truth) args.truth = args.wav.replace(/\.wav$/i, ".truth.json");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  for (const [label, file] of [
    ["audio", args.wav],
    ["truth", args.truth],
    ["model", args.model],
  ]) {
    if (!fs.existsSync(file)) {
      console.error(`Missing ${label}: ${file}`);
      process.exitCode = 1;
      return;
    }
  }

  const truth = JSON.parse(fs.readFileSync(args.truth, "utf8"));
  const utterances = truth.utterances || [];

  // Every transition where the voice changes is a boundary the diarizer is
  // supposed to mark.
  const trueBoundaries = [];
  for (let i = 0; i + 1 < utterances.length; i += 1) {
    if (utterances[i].speaker !== utterances[i + 1].speaker) {
      trueBoundaries.push({
        atSec: utterances[i].endSec,
        from: utterances[i].speaker,
        to: utterances[i + 1].speaker,
        index: i,
      });
    }
  }

  console.log(`audio      ${args.wav}`);
  console.log(
    `truth      ${utterances.length} utterances, ${trueBoundaries.length} speaker-change boundaries`
  );
  console.log(`model      ${args.model}`);
  console.log(`tolerance  ±${args.tolerance}s`);

  const manager = new WhisperServerManager();
  await manager.setForceCpu(true);

  let result;
  const started = Date.now();
  try {
    await manager.start(args.model, { printRealtime: false });
    console.log(`engine     ${manager.getEngineStatus().effectiveEngine}`);
    result = await manager.transcribe(fs.readFileSync(args.wav), {
      language: "en",
      fileMode: true,
      speakerDetection: true,
      inputFileName: path.basename(args.wav),
    });
  } finally {
    await manager.stop();
  }
  console.log(`elapsed    ${((Date.now() - started) / 1000).toFixed(1)}s wall`);

  const segments = Array.isArray(result?.segments) ? result.segments : [];
  const markers = segments
    .filter((segment) => /\[\s*SPEAKER_TURN\s*\]/i.test(String(segment.text || "")))
    .map((segment) => ({
      atSec: Number(segment.end),
      text: String(segment.text || "").slice(0, 80),
    }));

  console.log(`segments   ${segments.length}`);
  console.log(`markers    ${markers.length} predicted speaker turns`);
  if (args.transcript) {
    for (const segment of segments) {
      console.log(
        `  [${Number(segment.start).toFixed(2)}-${Number(segment.end).toFixed(2)}] ${segment.text}`
      );
    }
  }

  let hits = 0;
  const misses = [];
  for (const boundary of trueBoundaries) {
    const hit = markers.some((marker) => Math.abs(marker.atSec - boundary.atSec) <= args.tolerance);
    if (hit) hits += 1;
    else misses.push(boundary);
  }
  // Markers not near any true boundary are false alarms; report them too so a
  // marker-spammer cannot look good.
  const falseAlarms = markers.filter(
    (marker) => !trueBoundaries.some((b) => Math.abs(marker.atSec - b.atSec) <= args.tolerance)
  );

  console.log("");
  for (const boundary of misses) {
    console.log(
      `missed boundary @${boundary.atSec.toFixed(2)}s (${boundary.from} -> ${boundary.to})`
    );
  }
  for (const alarm of falseAlarms) {
    console.log(`false marker @${alarm.atSec.toFixed(2)}s: ${alarm.text}`);
  }
  console.log("");
  console.log(`TURN_BOUNDARIES=${trueBoundaries.length}`);
  console.log(`TURN_MARKERS=${markers.length}`);
  console.log(`TURN_FALSE_MARKERS=${falseAlarms.length}`);
  console.log(
    `TURN_RECALL=${trueBoundaries.length > 0 ? (hits / trueBoundaries.length).toFixed(4) : "0.0000"}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
