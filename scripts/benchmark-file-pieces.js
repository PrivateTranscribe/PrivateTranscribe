#!/usr/bin/env node
/**
 * benchmark-file-pieces.js
 *
 * Compares the two ways a file reaches local Whisper: as speech pieces of at
 * most 30 s cut in pauses (the default), and as one request that whisper.cpp
 * walks through in its own 30 s windows (speechPieces: false, the old path).
 *
 * The file is built from FLEURS utterances (CC-BY-4.0, the same cache
 * benchmark-transcription-accuracy.js uses) joined with pauses of varied
 * length, so there is a reference transcript for the whole thing. FLEURS
 * sentences are unrelated to each other, so this measures cutting and
 * silence handling, not how much a model gains from a long topic.
 *
 * Usage:
 *   node scripts/benchmark-file-pieces.js --language da --minutes 10
 *   node scripts/benchmark-file-pieces.js --language en --model ggml-base.bin --cpu
 *
 * Options:
 *   --language <code>  FLEURS language (default da)
 *   --minutes <n>      Length of the built file (default 10)
 *   --model <file>     Model file name in the whisper-models cache
 *                      (default ggml-large-v3-turbo.bin)
 *   --cpu              Force the CPU engine
 *   --cuda             Use the CUDA engine the installed app downloaded to
 *                      %APPDATA%\PrivateTranscribe\bin (plain Node has no
 *                      Electron app to find it with)
 *   --keep <path>      Also write the built WAV here
 *   --noise <dBFS>     Lay steady white noise this loud under the whole file
 *                      (for example -45), so pauses sound like a room rather
 *                      than digital silence
 *   --level <dBFS>     Bring every utterance to this loudness first (for
 *                      example -26). FLEURS levels run from -17 to -68 dBFS,
 *                      and the quietest are below any realistic room noise
 *   --json <path>      Also write both transcripts and the reference here
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const WhisperServerManager = require("../src/helpers/whisperServer.js");
const { createPcm16WavBuffer } = require("../src/helpers/wavPcm.js");
const {
  FLEURS_LOCALES,
  ensureDataset,
  loadSamples,
  toWords,
  wordErrors,
} = require("./benchmark-transcription-accuracy.js");

const SAMPLE_RATE = 16000;
// Pauses between sentences, cycled in order so every run builds the same file.
// Short ones sit under the detector's 0.5 s minimum silence and stay inside a
// region; long ones are skipped outright by the piece path.
const PAUSES_SECONDS = [0.3, 1.2, 0.6, 2.5, 0.4, 0.9, 4.0, 0.5, 1.6, 0.35];

function parseArgs(argv) {
  const args = {
    language: "da",
    minutes: 10,
    model: "ggml-large-v3-turbo.bin",
    cpu: false,
    cuda: false,
    keep: null,
    json: null,
    noise: null,
    level: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === "--language" && value) args.language = argv[++i];
    else if (flag === "--minutes" && value) args.minutes = Number(argv[++i]);
    else if (flag === "--model" && value) args.model = argv[++i];
    else if (flag === "--keep" && value) args.keep = path.resolve(argv[++i]);
    else if (flag === "--json" && value) args.json = path.resolve(argv[++i]);
    else if (flag === "--cpu") args.cpu = true;
    else if (flag === "--cuda") args.cuda = true;
    else if (flag === "--noise" && value) args.noise = Number(argv[++i]);
    else if (flag === "--level" && value) args.level = Number(argv[++i]);
  }
  return args;
}

function decodePcm(file) {
  return execFileSync(
    ffmpegPath,
    ["-v", "error", "-i", file, "-f", "s16le", "-ac", "1", "-ar", String(SAMPLE_RATE), "-"],
    { maxBuffer: 64 * 1024 * 1024 }
  );
}

// Seeded so every run hears the same noise.
function addNoise(pcm, dbfs) {
  const amplitude = 32768 * Math.pow(10, dbfs / 20) * Math.sqrt(3);
  let seed = 12345;
  for (let i = 0; i + 2 <= pcm.length; i += 2) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const noise = ((seed / 0x7fffffff) * 2 - 1) * amplitude;
    const value = Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i) + noise)));
    pcm.writeInt16LE(value, i);
  }
}

function setLevel(pcm, dbfs) {
  let squares = 0;
  for (let i = 0; i + 2 <= pcm.length; i += 2) squares += pcm.readInt16LE(i) ** 2;
  const rms = Math.sqrt(squares / (pcm.length / 2)) / 32768;
  if (rms <= 0) return pcm;
  const gain = Math.pow(10, dbfs / 20) / rms;
  for (let i = 0; i + 2 <= pcm.length; i += 2) {
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i) * gain))), i);
  }
  return pcm;
}

function buildFixture(language, minutes, noiseDb, levelDb) {
  const locale = FLEURS_LOCALES[language];
  if (!locale) throw new Error(`No FLEURS split for ${language}`);
  const { tsvPath, audioDir } = ensureDataset(locale);
  const samples = loadSamples(tsvPath, audioDir, 0);
  const targetBytes = minutes * 60 * SAMPLE_RATE * 2;

  const parts = [];
  const references = [];
  let bytes = 0;
  for (let i = 0; i < samples.length && bytes < targetBytes; i += 1) {
    const decoded = decodePcm(samples[i].wavPath);
    const pcm = Number.isFinite(levelDb) ? setLevel(decoded, levelDb) : decoded;
    const pause = Buffer.alloc(
      Math.round(PAUSES_SECONDS[i % PAUSES_SECONDS.length] * SAMPLE_RATE) * 2
    );
    parts.push(pcm, pause);
    references.push(samples[i].reference);
    bytes += pcm.length + pause.length;
  }
  const pcm = Buffer.concat(parts);
  if (Number.isFinite(noiseDb)) addNoise(pcm, noiseDb);
  return {
    wav: createPcm16WavBuffer(pcm),
    reference: references.join(" "),
    utterances: references.length,
    seconds: bytes / (SAMPLE_RATE * 2),
  };
}

async function runOnce(manager, wav, language, speechPieces) {
  let chunks = 0;
  const started = Date.now();
  const result = await manager.transcribe(wav, {
    language,
    fileMode: true,
    speechPieces,
    inputFileName: "fixture.wav",
    onProgress: (progress) => {
      if (progress?.chunksTotal) chunks = progress.chunksTotal;
    },
  });
  return { text: result?.text || "", seconds: (Date.now() - started) / 1000, chunks };
}

function score(reference, text) {
  const ref = toWords(reference);
  const hyp = toWords(text);
  const errors = wordErrors(ref, hyp);
  return { wer: errors / ref.length, errors, refWords: ref.length, hypWords: hyp.length };
}

// Longest run of a repeated 5-word phrase count, the hallucination signal
// WhisperX reports as "5-Dup".
function repeatedFiveGrams(text) {
  const words = toWords(text);
  const seen = new Map();
  for (let i = 0; i + 5 <= words.length; i += 1) {
    const key = words.slice(i, i + 5).join(" ");
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  let duplicates = 0;
  for (const count of seen.values()) if (count > 1) duplicates += count - 1;
  return duplicates;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const modelPath = path.join(
    os.homedir(),
    ".cache",
    "PrivateTranscribe",
    "whisper-models",
    args.model
  );
  if (!fs.existsSync(modelPath)) throw new Error(`Model not downloaded: ${modelPath}`);

  const fixture = buildFixture(args.language, args.minutes, args.noise, args.level);
  if (args.keep) fs.writeFileSync(args.keep, fixture.wav);
  console.log(
    `file     ${fixture.seconds.toFixed(0)} s, ${fixture.utterances} FLEURS ${args.language} utterances`
  );
  console.log(`model    ${args.model}${args.cpu ? " (CPU)" : ""}`);
  if (Number.isFinite(args.level)) console.log(`level    ${args.level} dBFS per utterance`);
  if (Number.isFinite(args.noise)) console.log(`noise    ${args.noise} dBFS`);

  if (args.cuda) {
    const GpuBinaryManager = require("../src/helpers/gpuBinaryManager.js");
    const binDir = path.join(process.env.APPDATA || "", "PrivateTranscribe", "bin");
    GpuBinaryManager.prototype.getBinDir = () => binDir;
  }
  const manager = new WhisperServerManager();
  if (args.cpu) await manager.setForceCpu(true);
  const rows = [];
  try {
    await manager.start(modelPath, { printRealtime: false });
    console.log(`engine   ${manager.getEngineStatus().effectiveEngine}`);
    // Warm the model once so neither path pays the first-load cost.
    await runOnce(
      manager,
      createPcm16WavBuffer(fixture.wav.subarray(44, 44 + SAMPLE_RATE * 2 * 5)),
      args.language,
      false
    );
    for (const [label, speechPieces] of [
      ["old: one request", false],
      ["new: speech pieces", true],
    ]) {
      const run = await runOnce(manager, fixture.wav, args.language, speechPieces);
      rows.push({
        label,
        ...run,
        ...score(fixture.reference, run.text),
        dup: repeatedFiveGrams(run.text),
      });
    }
  } finally {
    await manager.stop();
  }

  console.log("");
  // FLEURS reads each sentence with several speakers, so the reference has
  // repeated phrases of its own; only the excess over it is hallucination.
  console.log(`reference 5-dup ${repeatedFiveGrams(fixture.reference)}`);
  for (const row of rows) {
    console.log(
      `${row.label.padEnd(20)} WER ${(row.wer * 100).toFixed(2)}%  errors ${row.errors}/${row.refWords}  ` +
        `words out ${row.hypWords}  5-dup ${row.dup}  requests ${row.chunks}  time ${row.seconds.toFixed(1)} s`
    );
  }
  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify({ reference: fixture.reference, rows }, null, 2));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
