#!/usr/bin/env node
/**
 * transcribe-clips.js
 *
 * Transcribes the recordings in tests/test-clips through the shipped local
 * Whisper path and prints the text, so real dictation can be inspected next to
 * a benchmark run.
 *
 * FLEURS is read speech by trained speakers. It is the right set for measuring
 * a rate, and the wrong set for believing that rate covers everyday dictation.
 * These clips are the counterweight, at the cost of having no reference
 * transcript - they are read, not scored.
 *
 * Usage:
 *   node scripts/transcribe-clips.js --language da --model turbo
 *   node scripts/transcribe-clips.js --dir tests/test-clips --model small
 */

const fs = require("fs");
const path = require("path");

const WhisperManager = require("../src/helpers/whisper.js");

const AUDIO_EXTENSIONS = new Set([".m4a", ".wav", ".mp3", ".flac", ".ogg", ".webm"]);

function parseArgs(argv) {
  const args = { dir: "tests/test-clips", language: "da", model: "turbo" };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--dir") ((args.dir = value), (i += 1));
    else if (flag === "--language") ((args.language = value), (i += 1));
    else if (flag === "--model") ((args.model = value), (i += 1));
  }
  return args;
}

async function run() {
  const args = parseArgs(process.argv);
  const dir = path.resolve(args.dir);
  const files = fs
    .readdirSync(dir)
    .filter((name) => AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort();

  if (files.length === 0) throw new Error(`No audio files in ${dir}`);

  const manager = new WhisperManager();
  console.log(`\n${files.length} clips, model ${args.model}, language ${args.language}\n`);

  for (const name of files) {
    const buffer = fs.readFileSync(path.join(dir, name));
    try {
      const result = await manager.transcribeLocalWhisper(buffer, {
        model: args.model,
        language: args.language,
        inputFileName: name,
      });
      console.log(`--- ${name}`);
      console.log(`${(result?.text || "").trim()}\n`);
    } catch (error) {
      console.log(`--- ${name}`);
      console.log(`FAILED: ${error.message}\n`);
    }
  }

  await manager.stopServer();
}

run().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
