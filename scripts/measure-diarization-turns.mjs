#!/usr/bin/env node
/**
 * measure-diarization-turns.mjs
 *
 * Scores the app's sherpa-onnx diarization path (DiarizationManager, the
 * engine the Transcribe page prefers when its models are installed) against
 * the frozen multispeaker fixture, with the same rules the tinydiarize
 * harness (measure-speaker-turns.mjs) used:
 *
 *   - a TRUE boundary is every utterance transition where the truth speaker
 *     changes, timed at the END of the earlier utterance;
 *   - a PREDICTED boundary is every adjacent pair of diarization segments
 *     whose speaker differs, timed at the END of the earlier segment;
 *   - a hit is a predicted boundary within ±tolerance of a true one, and
 *     predicted boundaries near no true boundary are counted as false
 *     alarms, so segment-spam cannot look good.
 *
 * It also reports the speaker-count accuracy (found vs truth distinct
 * speakers), because a diarizer that nails turns but invents speakers is
 * still wrong.
 *
 * It measures. It does not judge: the ledger gate (sherpa-diarization-
 * measured) compares TURN_RECALL to its bar.
 *
 * Usage:
 *   node scripts/measure-diarization-turns.mjs
 *   node scripts/measure-diarization-turns.mjs --tolerance 2 --transcript
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { DiarizationManager } = require("../src/helpers/diarizationManager");

const DEFAULT_WAV = path.join(REPO_ROOT, "tests", "fixtures", "multispeaker", "interview.wav");

function parseArgs(argv) {
  const args = { wav: DEFAULT_WAV, truth: null, tolerance: 2, transcript: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--wav" && value) ((args.wav = path.resolve(value)), (i += 1));
    else if (flag === "--truth" && value) ((args.truth = path.resolve(value)), (i += 1));
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
  ]) {
    if (!fs.existsSync(file)) {
      console.error(`Missing ${label}: ${file}`);
      process.exitCode = 1;
      return;
    }
  }

  const truth = JSON.parse(fs.readFileSync(args.truth, "utf8"));
  const utterances = truth.utterances || [];
  const truthSpeakers = new Set(utterances.map((u) => u.speaker));

  const trueBoundaries = [];
  for (let i = 0; i + 1 < utterances.length; i += 1) {
    if (utterances[i].speaker !== utterances[i + 1].speaker) {
      trueBoundaries.push({
        atSec: utterances[i].endSec,
        from: utterances[i].speaker,
        to: utterances[i + 1].speaker,
      });
    }
  }

  console.log(`audio      ${args.wav}`);
  console.log(
    `truth      ${utterances.length} utterances, ${truthSpeakers.size} speakers, ` +
      `${trueBoundaries.length} speaker-change boundaries`
  );
  console.log(`tolerance  ±${args.tolerance}s`);

  const manager = new DiarizationManager();
  const status = manager.getModelStatus();
  if (!status.ready) {
    console.error("Diarization models are not installed:");
    for (const missing of status.missing || []) console.error(`  - ${missing}`);
    process.exitCode = 1;
    return;
  }
  console.log(`engine     sherpa-onnx (${status.bundleId ?? "diarization models ready"})`);

  // App defaults: auto-clustering, no expected-speaker hint — the same call
  // the Transcribe page's local-diarization mode makes.
  const started = Date.now();
  const result = await manager.diarizeWavFile(args.wav, {});
  console.log(`elapsed    ${((Date.now() - started) / 1000).toFixed(1)}s wall`);

  const segments = [...(result.segments || [])].sort((a, b) => a.start - b.start);
  const markers = [];
  for (let i = 0; i + 1 < segments.length; i += 1) {
    if (segments[i].speaker !== segments[i + 1].speaker) {
      markers.push({ atSec: Number(segments[i].end), from: segments[i].speaker });
    }
  }

  console.log(`segments   ${segments.length}`);
  console.log(`speakers   ${result.speakerCount} found (truth ${truthSpeakers.size})`);
  console.log(`markers    ${markers.length} predicted speaker turns`);
  if (args.transcript) {
    for (const segment of segments) {
      console.log(`  [${segment.start.toFixed(2)}-${segment.end.toFixed(2)}] ${segment.speaker}`);
    }
  }

  let hits = 0;
  const misses = [];
  for (const boundary of trueBoundaries) {
    const hit = markers.some((marker) => Math.abs(marker.atSec - boundary.atSec) <= args.tolerance);
    if (hit) hits += 1;
    else misses.push(boundary);
  }
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
    console.log(`false marker @${alarm.atSec.toFixed(2)}s (${alarm.from})`);
  }
  console.log("");
  console.log(`TURN_BOUNDARIES=${trueBoundaries.length}`);
  console.log(`TURN_MARKERS=${markers.length}`);
  console.log(`TURN_FALSE_MARKERS=${falseAlarms.length}`);
  console.log(
    `TURN_RECALL=${trueBoundaries.length > 0 ? (hits / trueBoundaries.length).toFixed(4) : "0.0000"}`
  );
  console.log(`SPEAKER_COUNT_FOUND=${result.speakerCount}`);
  console.log(`SPEAKER_COUNT_TRUTH=${truthSpeakers.size}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
