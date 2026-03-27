#!/usr/bin/env node
/**
 * download-benchmark-audio.js
 *
 * Downloads a public-domain speech sample for the transcription benchmark.
 *
 * Source: JFK 1961 Inaugural Address — U.S. government work, public domain.
 *   "Ask not what your country can do for you..."
 *   ~11 seconds of clear speech — the canonical Whisper benchmark clip,
 *   used in OpenAI's own Whisper test suite.
 *
 * Requirements:
 *   ffmpeg   https://ffmpeg.org/download.html
 *
 * Usage:
 *   node scripts/download-benchmark-audio.js
 *   npm run download:benchmark-audio
 */

"use strict";

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

// ── Config ─────────────────────────────────────────────────────────────────

// JFK 1961 Inaugural Address — U.S. government work, public domain.
// This is the canonical Whisper benchmark clip (used in OpenAI's own test suite).
const AUDIO_URL =
  "https://raw.githubusercontent.com/openai/whisper/refs/heads/main/tests/jfk.flac";
const AUDIO_CREDIT = "JFK Inaugural Address (1961) · U.S. government work · public domain";

const OUT_PATH = path.join(__dirname, "..", "resources", "benchmark.wav");

// ── Helpers ────────────────────────────────────────────────────────────────

function checkFfmpeg() {
  const result = spawnSync("ffmpeg", ["-version"], { stdio: "pipe" });
  if (result.error) {
    console.error(
      "\n  ✗  ffmpeg not found on PATH.\n" +
        "     Install it: https://ffmpeg.org/download.html\n"
    );
    process.exit(1);
  }
  console.log("  ✓  ffmpeg found");
}

/** Download a URL to a local file, following redirects. */
function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const follow = (redirectUrl) => {
      const mod = redirectUrl.startsWith("https") ? https : http;
      mod
        .get(redirectUrl, { headers: { "User-Agent": "PrivateTranscribe/1.0" } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            follow(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} from ${redirectUrl}`));
            return;
          }
          const dest = fs.createWriteStream(destPath);
          res.pipe(dest);
          dest.on("finish", resolve);
          dest.on("error", reject);
        })
        .on("error", reject);
    };
    follow(url);
  });
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\nCommand failed: ${cmd} ${args.join(" ")}`);
    process.exit(result.status ?? 1);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("\nDownloading benchmark audio…");
  console.log(`Source: ${AUDIO_CREDIT}\n`);

  console.log("Checking dependencies:");
  checkFfmpeg();

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-bench-"));
  const tmpFlac = path.join(tmpDir, "sample.flac");

  console.log("\nDownloading speech sample…");
  try {
    await download(AUDIO_URL, tmpFlac);
  } catch (err) {
    console.error(`\n  ✗  Download failed: ${err.message}`);
    process.exit(1);
  }

  console.log("Converting to 16 kHz mono WAV…");
  run("ffmpeg", [
    "-y",
    "-i", tmpFlac,
    "-ar", "16000",
    "-ac", "1",
    "-sample_fmt", "s16",
    "-acodec", "pcm_s16le",
    "-t", "10",
    OUT_PATH,
  ]);

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // non-fatal
  }

  const stats = fs.statSync(OUT_PATH);
  const kb = Math.round(stats.size / 1024);
  console.log(`\n  ✓  Saved to resources/benchmark.wav (${kb} KB)`);
  console.log(`     ${AUDIO_CREDIT}`);
  console.log("     The benchmark will now use this file instead of synthetic noise.\n");
}

main();
