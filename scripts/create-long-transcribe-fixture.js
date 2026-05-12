#!/usr/bin/env node
/*
 * Create a long-but-small audio fixture for manual Transcribe File testing.
 *
 * Default on Windows: generate a Danish TTS phrase with SAPI, then loop it.
 * Default elsewhere: generate a tone fixture unless --input is provided.
 *
 * Example:
 *   npm run fixture:long-transcribe
 *   npm run fixture:long-transcribe -- --duration-min 65 --out tmp/long-da-65m.m4a
 *   npm run fixture:long-transcribe -- --input tests/test-clips/Repeat.m4a --duration-min 45
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ffmpegPath = require("ffmpeg-static");

const DEFAULT_PHRASE =
  "Dette er en dansk test af PrivateTranscribe. Hvis teksten bliver engelsk, oversat, eller meget mærkelig, er sprogdetektion eller chunking forkert.";

function parseArgs(argv) {
  const args = {
    durationMin: 60,
    bitrate: "48k",
    out: path.join("tmp", "long-transcribe-fixture-da-60m.m4a"),
    phrase: DEFAULT_PHRASE,
    input: null,
    mode: process.platform === "win32" ? "tts" : "tone",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--duration-min" && next) {
      args.durationMin = Number(next);
      index += 1;
    } else if (arg === "--bitrate" && next) {
      args.bitrate = next;
      index += 1;
    } else if (arg === "--out" && next) {
      args.out = next;
      index += 1;
    } else if (arg === "--phrase" && next) {
      args.phrase = next;
      index += 1;
    } else if (arg === "--input" && next) {
      args.input = next;
      args.mode = "input-loop";
      index += 1;
    } else if (arg === "--mode" && next) {
      args.mode = next;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.durationMin) || args.durationMin <= 0 || args.durationMin > 8 * 60) {
    throw new Error("--duration-min must be between 1 and 480");
  }

  if (!["tts", "tone", "input-loop"].includes(args.mode)) {
    throw new Error("--mode must be one of: tts, tone, input-loop");
  }

  return args;
}

function printHelp() {
  console.log(`Create a long Transcribe File fixture.\n\nOptions:\n  --duration-min <n>  Duration in minutes. Default: 60\n  --bitrate <rate>    AAC bitrate. Default: 48k\n  --out <path>        Output file. Default: tmp/long-transcribe-fixture-da-60m.m4a\n  --phrase <text>     TTS phrase for Windows mode\n  --input <path>      Loop this audio file instead of generating TTS/tone\n  --mode <mode>       tts | tone | input-loop\n\nRecommended Windows test:\n  npm run fixture:long-transcribe -- --duration-min 60\n\nThen drag the generated .m4a into Transcribe File in local Whisper mode with Language = Auto-detect.`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}`);
  }
}

function escapePowerShellSingleQuotedString(value) {
  return String(value).replace(/'/g, "''");
}

function createWindowsTtsWav(outPath, phrase) {
  const psScript = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = 0
$synth.Volume = 100
$synth.SetOutputToWaveFile('${escapePowerShellSingleQuotedString(outPath)}')
$synth.Speak('${escapePowerShellSingleQuotedString(phrase)}')
$synth.Dispose()
`;

  const scriptPath = path.join(os.tmpdir(), `pt-tts-${Date.now()}.ps1`);
  fs.writeFileSync(scriptPath, psScript, "utf8");
  try {
    run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath]);
  } finally {
    fs.rmSync(scriptPath, { force: true });
  }
}

function createToneWav(outPath) {
  run(ffmpegPath, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=6:sample_rate=16000",
    "-ac",
    "1",
    outPath,
  ]);
}

function createLoopedFixture({ basePath, outPath, durationSeconds, bitrate }) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  run(ffmpegPath, [
    "-y",
    "-stream_loop",
    "-1",
    "-i",
    basePath,
    "-t",
    String(durationSeconds),
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "aac",
    "-b:a",
    bitrate,
    outPath,
  ]);
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

async function main() {
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    throw new Error("ffmpeg-static binary not found. Run npm install first.");
  }

  const args = parseArgs(process.argv.slice(2));
  const durationSeconds = Math.round(args.durationMin * 60);
  const outPath = path.resolve(args.out);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-long-fixture-"));
  let basePath = args.input ? path.resolve(args.input) : path.join(tempDir, "base.wav");

  try {
    if (args.input) {
      if (!fs.existsSync(basePath)) throw new Error(`Input file not found: ${basePath}`);
    } else if (args.mode === "tts") {
      if (process.platform !== "win32") {
        throw new Error("TTS mode currently uses Windows SAPI. Use --input or --mode tone here.");
      }
      console.log("Creating short Windows TTS seed clip...");
      createWindowsTtsWav(basePath, args.phrase);
    } else {
      console.log("Creating tone seed clip. Note: tone fixtures test chunking, not transcription language quality.");
      createToneWav(basePath);
    }

    console.log(`Creating ${args.durationMin} minute fixture...`);
    createLoopedFixture({ basePath, outPath, durationSeconds, bitrate: args.bitrate });

    const size = fs.statSync(outPath).size;
    console.log("\nLong Transcribe File fixture created:");
    console.log(`  ${outPath}`);
    console.log(`  Duration: ${args.durationMin} minutes`);
    console.log(`  Size: ${formatBytes(size)}`);
    console.log(`  Bitrate: ${args.bitrate}`);
    console.log("\nManual test:");
    console.log("  1. Open PrivateTranscribe → Settings → Transcription → Language = Auto-detect.");
    console.log("  2. Use local Whisper mode.");
    console.log("  3. Drag this file into Transcribe File.");
    console.log("  4. Expected: no timeout/server crash; transcript remains in the source language.");
    if (args.mode === "tts") {
      console.log(`\nExpected repeated phrase:\n  ${args.phrase}`);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`\nFailed to create fixture: ${error.message}`);
  process.exit(1);
});
