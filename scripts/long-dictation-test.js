#!/usr/bin/env node

"use strict";

const fs = require("fs");
const https = require("https");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const { buildBoundaryChecks, scoreLongDictation } = require("./long-dictation-test-utils");

const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT_DIR, "tmp", "long-dictation-test");
const CACHE_DIR = path.join(OUTPUT_DIR, "cache");
const FIXTURE_PATH = path.join(OUTPUT_DIR, "long-dictation-fixture.wav");
const MANIFEST_PATH = path.join(OUTPUT_DIR, "long-dictation-fixture.manifest.json");
const REFERENCE_PATH = path.join(OUTPUT_DIR, "long-dictation-reference.txt");
const DATASET_API = "https://datasets-server.huggingface.co/rows";
const FIXTURE_VERSION = 1;
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const INTER_CLIP_SILENCE_MS = 250;
const TRAILING_SILENCE_SECONDS = 10;
const TARGET_DURATION_SECONDS = 390;
const ROW_PAGE_SIZE = 100;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

function parseArguments(argv) {
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "prepare";
  const values = new Map();
  const flags = new Set();
  const startIndex = command === "prepare" && argv[0]?.startsWith("--") ? 0 : 1;

  for (let index = startIndex; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    const key = argument.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      flags.add(key);
    }
  }

  return { command, flags, values };
}

function requestBuffer(url, maximumBytes = MAX_DOWNLOAD_BYTES, redirectsRemaining = 5) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          Accept: "application/json, audio/flac, application/octet-stream",
          "User-Agent": "PrivateTranscribe-Long-Dictation-Test/1.0",
        },
      },
      (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          if (redirectsRemaining === 0) {
            reject(new Error(`Too many redirects while downloading ${url}`));
            return;
          }
          const redirectUrl = new URL(response.headers.location, url).toString();
          requestBuffer(redirectUrl, maximumBytes, redirectsRemaining - 1).then(resolve, reject);
          return;
        }

        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`HTTP ${response.statusCode} from ${url}`));
          return;
        }

        const declaredLength = Number(response.headers["content-length"] || 0);
        if (declaredLength > maximumBytes) {
          response.resume();
          reject(new Error(`Response from ${url} is larger than ${maximumBytes} bytes`));
          return;
        }

        const chunks = [];
        let receivedBytes = 0;
        response.on("data", (chunk) => {
          receivedBytes += chunk.length;
          if (receivedBytes > maximumBytes) {
            response.destroy(new Error(`Response from ${url} exceeded ${maximumBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve(Buffer.concat(chunks)));
        response.on("error", reject);
      }
    );
    request.setTimeout(30000, () => request.destroy(new Error(`Timed out downloading ${url}`)));
    request.on("error", reject);
  });
}

async function requestWithRetries(url, maximumBytes, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestBuffer(url, maximumBytes);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }
  throw lastError;
}

async function getDatasetRows(offset) {
  const query = new URLSearchParams({
    dataset: "openslr/librispeech_asr",
    config: "clean",
    split: "test",
    offset: String(offset),
    length: String(ROW_PAGE_SIZE),
  });
  const response = await requestWithRetries(`${DATASET_API}?${query}`, 8 * 1024 * 1024);
  const body = JSON.parse(response.toString("utf8"));
  return Array.isArray(body.rows) ? body.rows.map((entry) => entry.row) : [];
}

function getAudioUrl(row) {
  const audio = Array.isArray(row.audio) ? row.audio[0] : row.audio;
  const source = audio?.src || audio?.url;
  if (!source || !source.startsWith("https://")) {
    throw new Error(`Dataset row ${row.id || "unknown"} does not contain an HTTPS audio URL`);
  }
  return source;
}

function runFfmpeg(inputPath, outputPath) {
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    throw new Error("ffmpeg-static is unavailable. Run npm install before preparing the fixture.");
  }

  const result = spawnSync(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      String(CHANNELS),
      "-c:a",
      "pcm_s16le",
      outputPath,
    ],
    { stdio: "pipe", encoding: "utf8" }
  );

  if (result.status !== 0) {
    throw new Error(`FFmpeg could not decode ${path.basename(inputPath)}: ${result.stderr.trim()}`);
  }
}

function readPcm16Wav(wavPath) {
  const wav = fs.readFileSync(wavPath);
  if (
    wav.length < 44 ||
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error(`${wavPath} is not a valid RIFF/WAVE file`);
  }

  let format = null;
  let pcm = null;
  for (let offset = 12; offset + 8 <= wav.length; ) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + chunkSize > wav.length) break;

    if (chunkId === "fmt ") {
      format = {
        audioFormat: wav.readUInt16LE(dataOffset),
        channels: wav.readUInt16LE(dataOffset + 2),
        sampleRate: wav.readUInt32LE(dataOffset + 4),
        bitsPerSample: wav.readUInt16LE(dataOffset + 14),
      };
    } else if (chunkId === "data") {
      pcm = wav.subarray(dataOffset, dataOffset + chunkSize);
    }

    offset = dataOffset + chunkSize + (chunkSize % 2);
  }

  if (
    !format ||
    !pcm ||
    format.audioFormat !== 1 ||
    format.channels !== CHANNELS ||
    format.sampleRate !== SAMPLE_RATE ||
    format.bitsPerSample !== BITS_PER_SAMPLE
  ) {
    throw new Error(`${wavPath} was not normalized to 16 kHz mono PCM16 audio`);
  }
  return pcm;
}

function createPcm16Wav(pcm) {
  const bytesPerSample = BITS_PER_SAMPLE / 8;
  const byteRate = SAMPLE_RATE * CHANNELS * bytesPerSample;
  const blockAlign = CHANNELS * bytesPerSample;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function durationForPcm(pcm) {
  return pcm.length / (SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8));
}

async function downloadAndDecode(row) {
  const safeId = String(row.id).replace(/[^a-zA-Z0-9_-]/g, "_");
  const flacPath = path.join(CACHE_DIR, `${safeId}.flac`);
  const wavPath = path.join(CACHE_DIR, `${safeId}.wav`);

  if (!fs.existsSync(wavPath)) {
    if (!fs.existsSync(flacPath)) {
      const audio = await requestWithRetries(getAudioUrl(row), MAX_DOWNLOAD_BYTES);
      fs.writeFileSync(flacPath, audio);
    }
    runFfmpeg(flacPath, wavPath);
  }

  return readPcm16Wav(wavPath);
}

function fixtureIsReusable() {
  if (!fs.existsSync(FIXTURE_PATH) || !fs.existsSync(MANIFEST_PATH)) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    return (
      manifest.fixtureVersion === FIXTURE_VERSION &&
      manifest.durationSeconds >= TARGET_DURATION_SECONDS &&
      manifest.clips?.length > 0
    );
  } catch {
    return false;
  }
}

async function prepareFixture({ force = false } = {}) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (!force && fixtureIsReusable()) {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    console.log(`Using cached ${manifest.durationSeconds.toFixed(1)} second fixture:`);
    console.log(`  ${FIXTURE_PATH}`);
    return manifest;
  }

  console.log("Preparing a real-speech long-dictation fixture from LibriSpeech test-clean...");
  const chunks = [];
  const clips = [];
  const silenceBytes = Math.round((SAMPLE_RATE * INTER_CLIP_SILENCE_MS) / 1000) * 2;
  const interClipSilence = Buffer.alloc(silenceBytes);
  let timelineSeconds = 0;
  let rowOffset = 0;

  while (timelineSeconds < TARGET_DURATION_SECONDS - TRAILING_SILENCE_SECONDS) {
    const rows = await getDatasetRows(rowOffset);
    if (rows.length === 0) throw new Error("LibriSpeech test-clean returned no more rows");

    for (const row of rows) {
      const pcm = await downloadAndDecode(row);
      const clipDuration = durationForPcm(pcm);
      const startSeconds = timelineSeconds;
      chunks.push(pcm, interClipSilence);
      timelineSeconds += clipDuration + INTER_CLIP_SILENCE_MS / 1000;
      clips.push({
        id: String(row.id),
        speakerId: String(row.speaker_id),
        chapterId: String(row.chapter_id),
        startSeconds: Number(startSeconds.toFixed(3)),
        endSeconds: Number((startSeconds + clipDuration).toFixed(3)),
        text: String(row.text).trim(),
      });
      process.stdout.write(
        `\r  ${clips.length} clips decoded · ${timelineSeconds.toFixed(1)} / ${TARGET_DURATION_SECONDS}s`
      );

      if (timelineSeconds >= TARGET_DURATION_SECONDS - TRAILING_SILENCE_SECONDS) break;
    }
    rowOffset += rows.length;
  }

  const trailingSilence = Buffer.alloc(SAMPLE_RATE * TRAILING_SILENCE_SECONDS * 2);
  chunks.push(trailingSilence);
  timelineSeconds += TRAILING_SILENCE_SECONDS;
  const pcm = Buffer.concat(chunks);
  fs.writeFileSync(FIXTURE_PATH, createPcm16Wav(pcm));

  const referenceText = clips.map((clip) => clip.text).join(" ");
  const manifest = {
    fixtureVersion: FIXTURE_VERSION,
    generatedAt: new Date().toISOString(),
    source: {
      dataset: "openslr/librispeech_asr",
      config: "clean",
      split: "test",
      openSlrUrl: "https://www.openslr.org/12",
      huggingFaceUrl: "https://huggingface.co/datasets/openslr/librispeech_asr",
      license: "CC BY 4.0",
    },
    audio: {
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      bitsPerSample: BITS_PER_SAMPLE,
      interClipSilenceMs: INTER_CLIP_SILENCE_MS,
      trailingSilenceSeconds: TRAILING_SILENCE_SECONDS,
    },
    durationSeconds: Number(timelineSeconds.toFixed(3)),
    referenceText,
    boundaryChecks: buildBoundaryChecks(clips),
    clips,
  };
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(REFERENCE_PATH, `${referenceText}\n`);
  process.stdout.write("\n");
  console.log(`Fixture ready: ${FIXTURE_PATH}`);
  console.log(`Duration: ${manifest.durationSeconds.toFixed(1)} seconds (${clips.length} clips)`);
  console.log(`Reference: ${REFERENCE_PATH}`);
  return manifest;
}

function scoreTranscript(transcriptPath, maximumWordErrorRate) {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Fixture manifest not found. Run "npm run fixture:long-dictation" first.`);
  }
  const resolvedTranscriptPath = path.resolve(ROOT_DIR, transcriptPath);
  if (!fs.existsSync(resolvedTranscriptPath)) {
    throw new Error(`Transcript file not found: ${resolvedTranscriptPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const transcript = fs.readFileSync(resolvedTranscriptPath, "utf8");
  const result = scoreLongDictation(manifest, transcript, { maximumWordErrorRate });
  console.log(`\nLong-dictation result: ${result.passed ? "PASS" : "FAIL"}`);
  console.log(
    `Word error rate: ${(result.wordErrorRate * 100).toFixed(1)}% (limit ${(maximumWordErrorRate * 100).toFixed(0)}%)`
  );
  for (const boundary of result.boundaryResults) {
    console.log(
      `${boundary.label} passage: ${(boundary.recall * 100).toFixed(0)}% word recall${
        result.missingBoundaries.includes(boundary.label) ? " — MISSING" : ""
      }`
    );
  }
  if (result.repeatedTail) {
    console.log(
      `Repeated ending: "${result.repeatedTail.phrase}" × ${result.repeatedTail.repetitions}`
    );
  }
  return result;
}

function buildElectronArguments(fixturePath, appDirectory) {
  return [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-audio-capture=${fixturePath}%noloop`,
    appDirectory,
  ];
}

async function launchFixture(force) {
  const manifest = await prepareFixture({ force });
  const electronPath = require("electron");
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;

  console.log("\nStarting PrivateTranscribe with the fixture as its microphone.");
  console.log("1. Start dictation normally; the fixture begins when microphone capture starts.");
  console.log(`2. Stop dictation after about ${Math.ceil(manifest.durationSeconds)} seconds.`);
  console.log("3. Save the pasted result as tmp/long-dictation-output.txt.");
  console.log(
    "4. Run: npm run score:long-dictation -- --transcript tmp/long-dictation-output.txt\n"
  );

  const child = spawn(electronPath, buildElectronArguments(FIXTURE_PATH, ROOT_DIR), {
    cwd: ROOT_DIR,
    env: environment,
    stdio: "inherit",
  });
  child.on("error", (error) => {
    console.error(`Could not start Electron: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("close", (code) => {
    process.exitCode = code || 0;
  });
}

function printHelp() {
  console.log(`
Long dictation regression test

  npm run fixture:long-dictation
  npm run start:long-dictation-test
  npm run score:long-dictation -- --transcript <text-file>

Options:
  --force             Rebuild the cached fixture
  --max-wer <0..1>    Override the scoring limit (default: 0.35)
`);
}

async function main() {
  const { command, flags, values } = parseArguments(process.argv.slice(2));
  if (flags.has("help") || command === "help") {
    printHelp();
    return;
  }

  if (command === "prepare") {
    await prepareFixture({ force: flags.has("force") });
    return;
  }
  if (command === "launch") {
    await launchFixture(flags.has("force"));
    return;
  }
  if (command === "score") {
    const transcriptPath = values.get("transcript");
    if (!transcriptPath) throw new Error("The score command requires --transcript <text-file>");
    const maximumWordErrorRate = Number(values.get("max-wer") || 0.35);
    if (
      !Number.isFinite(maximumWordErrorRate) ||
      maximumWordErrorRate < 0 ||
      maximumWordErrorRate > 1
    ) {
      throw new Error("--max-wer must be a number between 0 and 1");
    }
    const result = scoreTranscript(transcriptPath, maximumWordErrorRate);
    if (!result.passed) process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\nLong dictation test failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildElectronArguments,
  createPcm16Wav,
  parseArguments,
  prepareFixture,
  readPcm16Wav,
  scoreTranscript,
};
