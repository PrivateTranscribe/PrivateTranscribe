#!/usr/bin/env node

"use strict";

/**
 * Headless long-dictation regression run.
 *
 * `long-dictation-test.js launch` is the authoritative test: it feeds the
 * fixture into Chromium as a fake microphone so the real recorder, segment
 * rotation and paste path are exercised. It also needs an operator to start and
 * stop dictation by hand.
 *
 * This runner covers everything downstream of the recorder without one: it
 * slices the fixture the way AudioManager chunks a long session, sends each
 * chunk through the real WhisperManager (model resolution, server startup,
 * trailing-silence trimming, silent-chunk skipping and repetition cleanup all
 * included), joins the chunks the way finalizeLongSessionResult does, and
 * scores the result with the same scorer the manual test uses.
 *
 * It does NOT cover MediaRecorder capture, live rotation timing, or pasting.
 * A pass here does not replace a manual run before a release.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const { scoreLongDictation } = require("./long-dictation-test-utils");

const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT_DIR, "tmp", "long-dictation-test");
const FIXTURE_PATH = path.join(OUTPUT_DIR, "long-dictation-fixture.wav");
const MANIFEST_PATH = path.join(OUTPUT_DIR, "long-dictation-fixture.manifest.json");
const TRANSCRIPT_PATH = path.join(ROOT_DIR, "tmp", "long-dictation-headless-output.txt");
const WORK_DIR = path.join(OUTPUT_DIR, "headless-chunks");

// Mirrors src/helpers/audioManager.js. A recording is promoted to a long
// session at five minutes, and the segment recorder then rotates at the first
// pause after 60s, capped at 90s. Wall-clock slicing at the cap is the
// deterministic approximation: the fixture's inter-clip gaps are 250ms, below
// the 300ms pause hold, so a live run lands on the cap here too.
const PROMOTION_SECONDS = 5 * 60;
const SEGMENT_CAP_SECONDS = 90;

// Preference order when --model is not supplied; the first one already on disk wins.
const MODEL_PREFERENCE = ["large", "turbo", "medium", "small", "base", "tiny"];
const DEFAULT_MAX_WORD_ERROR_RATE = 0.2;

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    const name = argument.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(name, next);
      index += 1;
    } else {
      values.set(name, "true");
    }
  }
  return values;
}

function sliceFixture(durationSeconds) {
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });

  const boundaries = [];
  if (durationSeconds <= PROMOTION_SECONDS) {
    boundaries.push([0, durationSeconds]);
  } else {
    boundaries.push([0, PROMOTION_SECONDS]);
    for (let start = PROMOTION_SECONDS; start < durationSeconds; start += SEGMENT_CAP_SECONDS) {
      boundaries.push([start, Math.min(start + SEGMENT_CAP_SECONDS, durationSeconds)]);
    }
  }

  return boundaries.map(([start, end], index) => {
    const chunkPath = path.join(WORK_DIR, `chunk-${index}.wav`);
    const result = spawnSync(
      ffmpegPath,
      [
        "-i",
        FIXTURE_PATH,
        "-ss",
        String(start),
        "-t",
        String(end - start),
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        "-y",
        chunkPath,
      ],
      { encoding: "utf8" }
    );
    if (!fs.existsSync(chunkPath)) {
      throw new Error(`FFmpeg could not slice chunk ${index}: ${result.stderr?.slice(-300)}`);
    }
    return { index, start, end, chunkPath };
  });
}

function resolveModel(whisperManager, requested) {
  const candidates = requested ? [requested] : MODEL_PREFERENCE;
  for (const name of candidates) {
    try {
      if (whisperManager.getModelFileStatus(name).valid) return name;
    } catch {
      // Unknown model name — fall through to the error below.
    }
  }
  throw new Error(
    requested
      ? `Whisper model "${requested}" is not downloaded. Download it in Settings first.`
      : `No Whisper model found. Download one in Settings, or pass --model <name>.`
  );
}

async function main() {
  const values = parseArguments(process.argv.slice(2));

  if (!fs.existsSync(FIXTURE_PATH) || !fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Fixture not found. Run "npm run fixture:long-dictation" first.`);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const WhisperManager = require("../src/helpers/whisper");
  const whisperManager = new WhisperManager();
  const model = resolveModel(whisperManager, values.get("model"));

  console.log(`Fixture: ${manifest.durationSeconds.toFixed(1)}s`);
  console.log(`Model:   ${model}`);

  const chunks = sliceFixture(manifest.durationSeconds);
  console.log(
    `Chunks:  ${chunks.length} (promotion at ${PROMOTION_SECONDS}s, then ${SEGMENT_CAP_SECONDS}s)\n`
  );

  const texts = [];
  try {
    for (const chunk of chunks) {
      const audio = fs.readFileSync(chunk.chunkPath);
      const result = await whisperManager.transcribeLocalWhisper(audio, {
        model,
        language: "en",
        inputFileName: "chunk.wav",
        // Every live long-session chunk is sent with these.
        longSessionChunk: true,
        trimTrailingSilence: true,
      });

      const text = String(result?.text || "").trim();
      const span = `[${chunk.start.toFixed(0)}-${chunk.end.toFixed(0)}s]`;
      if (!text) {
        console.log(`chunk ${chunk.index} ${span}: no speech, skipped`);
        continue;
      }
      console.log(`chunk ${chunk.index} ${span}: ${text.split(/\s+/).length} words`);
      texts.push(text);
    }
  } finally {
    await whisperManager.serverManager?.stop?.().catch?.(() => {});
  }

  // Matches finalizeLongSessionResult.
  const transcript = texts.filter(Boolean).join(" ").trim();
  fs.mkdirSync(path.dirname(TRANSCRIPT_PATH), { recursive: true });
  fs.writeFileSync(TRANSCRIPT_PATH, transcript, "utf8");

  const maximumWordErrorRate = values.has("max-wer")
    ? Number(values.get("max-wer"))
    : DEFAULT_MAX_WORD_ERROR_RATE;
  const result = scoreLongDictation(manifest, transcript, { maximumWordErrorRate });

  console.log(`\nTranscript: ${TRANSCRIPT_PATH}`);
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
  if (result.repeatedPassage) {
    console.log(
      `Repeated passage: ${result.repeatedPassage.wordCount} words duplicated ("${result.repeatedPassage.phrase}")`
    );
  }
  if (result.unexpectedTail) {
    console.log(
      `Unexpected ending: ${result.unexpectedTail.wordCount} unsupported words ("${result.unexpectedTail.text}")`
    );
  }

  if (!result.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
