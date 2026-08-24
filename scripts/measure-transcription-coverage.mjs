#!/usr/bin/env node
/**
 * measure-transcription-coverage.mjs
 *
 * Transcribes a fixture WAV with the same whisper.cpp binary and the same flags
 * the app's file-transcription pipeline uses, then reports what fraction of the
 * known words came back.
 *
 * It measures. It does not judge: there is no threshold in this file and no
 * exit code that means "too low". A gate that wants to compare this number to a
 * baseline is welcome to, but the number has to exist before anyone can argue
 * about it.
 *
 * The pipeline is not reimplemented here. WhisperServerManager is the app's own
 * file path, so "same binary, same flags" is a fact rather than a claim that
 * drifts the next time the flags change. CPU is forced (forceCpu adds --no-gpu
 * and selects the bundled CPU build) so a run never competes with the user's
 * GPU or their running app.
 *
 * Usage:
 *   node scripts/measure-transcription-coverage.mjs
 *   node scripts/measure-transcription-coverage.mjs --wav x.wav --truth x.truth.json
 *   node scripts/measure-transcription-coverage.mjs --model ~/.cache/.../ggml-small.bin
 *
 * Options:
 *   --wav <path>       Audio to transcribe (default the control fixture)
 *   --truth <path>     Truth JSON (default: the wav's path with .truth.json)
 *   --model <path>     GGML model file (default ggml-base.bin, the app's
 *                      recommended default)
 *   --language <code>  Language passed to whisper (default en; "auto" lets
 *                      whisper detect, which is what the app does by default)
 *   --transcript       Also print the full transcript
 */

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const WhisperServerManager = require("../src/helpers/whisperServer.js");

const DEFAULT_WAV = path.join(REPO_ROOT, "tests", "fixtures", "multispeaker", "control.wav");
const DEFAULT_MODEL = path.join(
  os.homedir(),
  ".cache",
  "PrivateTranscribe",
  "whisper-models",
  "ggml-base.bin"
);

// --------------------------------------------------------------- normalization

/**
 * Lowercase, drop apostrophes, turn every other non-alphanumeric run into a
 * space, collapse whitespace. Digits are kept.
 *
 * Apostrophes are removed rather than replaced with a space so "don't" stays one
 * token on both sides instead of becoming "don" plus "t".
 *
 * Deliberately not gameable: no stemming, no fuzzy matching, no synonym list. A
 * word counts when the transcript contains that exact word.
 */
function normalizeWords(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/['’ʼ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function toCounts(words) {
  const counts = new Map();
  for (const word of words) counts.set(word, (counts.get(word) || 0) + 1);
  return counts;
}

/**
 * Bag-of-words coverage: for every distinct truth word, credit at most as many
 * occurrences as the transcript actually contains. Multiset intersection, so a
 * transcript cannot inflate its score by repeating one word it got right.
 */
function coverage(truthWords, hypWords) {
  const truthCounts = toCounts(truthWords);
  const hypCounts = toCounts(hypWords);

  let matched = 0;
  const missed = [];
  for (const [word, truthCount] of truthCounts) {
    const hit = Math.min(truthCount, hypCounts.get(word) || 0);
    matched += hit;
    if (hit < truthCount) missed.push({ word, missing: truthCount - hit, expected: truthCount });
  }

  missed.sort((a, b) => b.missing - a.missing || a.word.localeCompare(b.word));

  return {
    coverage: truthWords.length > 0 ? matched / truthWords.length : 0,
    matched,
    truthTotal: truthWords.length,
    hypTotal: hypWords.length,
    missed,
  };
}

// ----------------------------------------------------------------------- args

function parseArgs(argv) {
  const args = {
    wav: DEFAULT_WAV,
    truth: null,
    model: DEFAULT_MODEL,
    language: "en",
    transcript: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--wav" && value) {
      args.wav = path.resolve(value);
      i += 1;
    } else if (flag === "--truth" && value) {
      args.truth = path.resolve(value);
      i += 1;
    } else if (flag === "--model" && value) {
      args.model = path.resolve(value);
      i += 1;
    } else if (flag === "--language" && value) {
      args.language = value;
      i += 1;
    } else if (flag === "--transcript") {
      args.transcript = true;
    }
  }
  if (!args.truth) {
    args.truth = args.wav.replace(/\.wav$/i, ".truth.json");
  }
  return args;
}

// ----------------------------------------------------------------------- main

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
  if (!Array.isArray(truth.utterances) || truth.utterances.length === 0) {
    throw new Error(`Truth file has no utterances: ${args.truth}`);
  }
  const truthText = truth.utterances.map((u) => u.text).join(" ");
  const truthWords = normalizeWords(truthText);

  console.log(`audio    ${args.wav}`);
  console.log(`truth    ${args.truth} (${truth.utterances.length} utterances, ${truth.totalSec}s)`);
  console.log(`model    ${args.model}`);
  console.log(`language ${args.language}`);

  const manager = new WhisperServerManager();
  // CPU only: adds --no-gpu and picks the bundled CPU build even when a CUDA
  // engine is installed, so this never contends with the user's GPU.
  await manager.setForceCpu(true);

  let result;
  const started = Date.now();
  try {
    await manager.start(args.model, { printRealtime: false });
    console.log(`server   ${manager.activeServerBinaryPath}`);
    console.log(`args     ${manager.buildServerArgs(args.model, {}).join(" ")}`);
    console.log(`engine   ${manager.getEngineStatus().effectiveEngine}`);

    result = await manager.transcribe(fs.readFileSync(args.wav), {
      language: args.language === "auto" ? null : args.language,
      // fileMode is what the app's transcribeFileV2 sets, and it carries the
      // decode settings (no_context, temperature, no_speech_thold) with it.
      fileMode: true,
      inputFileName: path.basename(args.wav),
    });
  } finally {
    await manager.stop();
  }
  const elapsedMs = Date.now() - started;

  const hypText = typeof result?.text === "string" ? result.text : "";
  const hypWords = normalizeWords(hypText);
  const scored = coverage(truthWords, hypWords);

  console.log("");
  if (args.transcript) {
    console.log(`transcript: ${hypText.trim()}`);
    console.log("");
  }
  console.log(`words truth=${scored.truthTotal} transcript=${scored.hypTotal} matched=${scored.matched}`);
  console.log(`elapsed  ${(elapsedMs / 1000).toFixed(1)}s wall (server start + convert + decode)`);
  if (result?.detectedLanguage) console.log(`detected ${result.detectedLanguage}`);
  console.log("");
  console.log(
    `missed (${scored.missed.reduce((sum, m) => sum + m.missing, 0)} tokens): ${
      scored.missed.map((m) => (m.missing > 1 ? `${m.word} x${m.missing}` : m.word)).join(", ") ||
      "none"
    }`
  );
  console.log("");
  console.log(`COVERAGE=${scored.coverage.toFixed(4)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
