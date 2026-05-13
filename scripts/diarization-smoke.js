#!/usr/bin/env node
/*
 * Smoke-test local multilingual diarization with a real audio file.
 *
 * Usage:
 *   npm run smoke:diarization -- /path/to/audio.wav --download --expected-speakers 2
 *   npm run smoke:diarization -- /path/to/audio.mp3 --threshold 0.85 --json out.json
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { DiarizationManager } = require("../src/helpers/diarizationManager");
const { convertToWav } = require("../src/helpers/ffmpegUtils");

function usage(exitCode = 0) {
  console.log(`Usage: node scripts/diarization-smoke.js <audio-file> [options]

Options:
  --download                    Download diarization models if missing
  --expected-speakers <number>   Hint/assert expected speaker count
  --threshold <number>           Clustering threshold (default: app default)
  --json <path>                  Write full diarization result JSON
  --models-dir <path>            Override diarization models directory
  --help                         Show this help

Examples:
  npm run smoke:diarization -- fixtures/da-two-speakers.wav --download --expected-speakers 2
  npm run smoke:diarization -- ~/Desktop/meeting.mp3 --threshold 0.85 --json /tmp/diarization.json
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { audioPath: null, download: false, expectedSpeakers: undefined, threshold: undefined, jsonPath: null, modelsDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage(0);
    if (arg === "--download") {
      args.download = true;
    } else if (arg === "--expected-speakers") {
      args.expectedSpeakers = Number.parseInt(argv[++i], 10);
    } else if (arg === "--threshold") {
      args.threshold = Number.parseFloat(argv[++i]);
    } else if (arg === "--json") {
      args.jsonPath = argv[++i];
    } else if (arg === "--models-dir") {
      args.modelsDir = argv[++i];
    } else if (!args.audioPath) {
      args.audioPath = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.audioPath) usage(1);

  const inputPath = path.resolve(args.audioPath);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Audio file not found: ${inputPath}`);
  }

  if (args.expectedSpeakers !== undefined && (!Number.isInteger(args.expectedSpeakers) || args.expectedSpeakers <= 0)) {
    throw new Error("--expected-speakers must be a positive integer");
  }
  if (args.threshold !== undefined && !Number.isFinite(args.threshold)) {
    throw new Error("--threshold must be a number");
  }

  const manager = new DiarizationManager(args.modelsDir ? { modelsDir: path.resolve(args.modelsDir) } : {});
  let status = manager.getModelStatus();

  if (!status.ready) {
    if (!args.download) {
      console.error("Diarization models are missing:");
      for (const missing of status.missing) console.error(`  - ${missing}`);
      console.error("Run again with --download to install them.");
      process.exit(2);
    }

    console.log("Downloading diarization models…");
    await manager.downloadModels((progress) => {
      const pct = Number.isFinite(progress.percentage) ? `${progress.percentage}%` : "";
      process.stdout.write(`\r${progress.stage || progress.type} ${pct}`.padEnd(80));
    });
    process.stdout.write("\n");
    status = manager.getModelStatus();
  }

  console.log(`Models ready: ${status.bundleId}`);
  const tempWavPath = path.join(os.tmpdir(), `privatetranscribe-diarization-smoke-${crypto.randomUUID()}.wav`);
  try {
    console.log("Converting input to 16kHz mono WAV…");
    await convertToWav(inputPath, tempWavPath, { sampleRate: 16000, channels: 1 });

    console.log("Running diarization…");
    const result = await manager.diarizeWavFile(tempWavPath, {
      expectedSpeakers: args.expectedSpeakers,
      threshold: args.threshold,
    });

    console.log("\nDiarization result");
    console.log(`  speakers: ${result.speakerCount} (${result.speakers.join(", ") || "none"})`);
    console.log(`  segments: ${result.segments.length}`);
    console.log(`  duration: ${result.durationSec?.toFixed?.(1) ?? "?"}s`);
    console.log(`  elapsed:  ${result.elapsedMs ?? "?"}ms`);
    console.log(`  rtf:      ${result.rtf ?? "?"}`);
    console.log("\nFirst segments:");
    for (const segment of result.segments.slice(0, 12)) {
      console.log(`  ${segment.start.toFixed(2)}-${segment.end.toFixed(2)}  ${segment.speaker}`);
    }

    if (args.jsonPath) {
      const outPath = path.resolve(args.jsonPath);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
      console.log(`\nWrote JSON: ${outPath}`);
    }

    if (args.expectedSpeakers && result.speakerCount !== args.expectedSpeakers) {
      throw new Error(`Expected ${args.expectedSpeakers} speakers, detected ${result.speakerCount}`);
    }
  } finally {
    fs.rmSync(tempWavPath, { force: true });
  }
}

main().catch((error) => {
  console.error(`\nSmoke test failed: ${error.message}`);
  process.exit(1);
});
