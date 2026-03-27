#!/usr/bin/env node
/**
 * download-benchmark-audio.js
 *
 * Downloads a 10-second clip for use as the local transcription benchmark.
 * The resulting file is saved to resources/benchmark.wav and is intentionally
 * excluded from git and production builds — it is a developer-only asset.
 *
 * Requirements (must be installed on your PATH):
 *   yt-dlp   https://github.com/yt-dlp/yt-dlp#installation
 *   ffmpeg   https://ffmpeg.org/download.html
 *
 * Usage:
 *   node scripts/download-benchmark-audio.js
 *   npm run download:benchmark-audio
 */

"use strict";

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ── Config ─────────────────────────────────────────────────────────────────

// dQw4w9WgXcQ — you know exactly what this is
const VIDEO_ID = "dQw4w9WgXcQ";
const CLIP_START = "0";
const CLIP_DURATION = "10"; // seconds — enough to stress the encoder+decoder
const OUT_PATH = path.join(__dirname, "..", "resources", "benchmark.wav");

// ── Helpers ────────────────────────────────────────────────────────────────

function checkDep(name) {
  const result = spawnSync(name, ["--version"], { stdio: "pipe" });
  if (result.status !== 0 && result.error) {
    console.error(
      `\n  ✗  ${name} not found on PATH.\n` +
        `     Install it first:\n` +
        (name === "yt-dlp"
          ? `     https://github.com/yt-dlp/yt-dlp#installation\n`
          : `     https://ffmpeg.org/download.html\n`)
    );
    process.exit(1);
  }
  console.log(`  ✓  ${name} found`);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.status !== 0) {
    console.error(`\nCommand failed: ${cmd} ${args.join(" ")}`);
    process.exit(result.status ?? 1);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

console.log("\nDownloading benchmark audio…\n");

// 1. Check deps
console.log("Checking dependencies:");
checkDep("yt-dlp");
checkDep("ffmpeg");

// 2. Ensure output directory exists
fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });

// 3. Download audio to a temp file
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-bench-"));
const tmpRaw = path.join(tmpDir, "raw.%(ext)s");
const tmpWav = path.join(tmpDir, "raw.wav");

console.log("\nDownloading audio track…");
run("yt-dlp", [
  `https://www.youtube.com/watch?v=${VIDEO_ID}`,
  "--format", "bestaudio",
  "--extract-audio",
  "--audio-format", "wav",
  "--output", tmpRaw,
  "--no-playlist",
  "--quiet",
  "--progress",
]);

// yt-dlp may write the file with any extension — find it
const rawFile = fs.readdirSync(tmpDir).find((f) => f !== "raw.wav");
const rawPath = rawFile ? path.join(tmpDir, rawFile) : tmpWav;

// 4. Convert + trim to 10-second, 16 kHz, mono, 16-bit PCM WAV
console.log(`\nConverting to 16 kHz mono WAV (${CLIP_DURATION}s)…`);
run("ffmpeg", [
  "-y",
  "-ss", CLIP_START,
  "-t", CLIP_DURATION,
  "-i", rawPath,
  "-ar", "16000",
  "-ac", "1",
  "-sample_fmt", "s16",
  "-acodec", "pcm_s16le",
  OUT_PATH,
]);

// 5. Cleanup temp files
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {
  // non-fatal
}

// 6. Verify
const stats = fs.statSync(OUT_PATH);
const kb = Math.round(stats.size / 1024);
console.log(`\n  ✓  Saved to resources/benchmark.wav (${kb} KB)`);
console.log("     The benchmark will now use this file instead of synthetic noise.\n");
