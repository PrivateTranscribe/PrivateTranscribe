#!/usr/bin/env node
/**
 * generate-dictation-fixture.mjs
 *
 * Builds the single-sentence dictation fixture used by the end-to-end
 * Correction Memory gate: one short spoken sentence, written as a PCM WAV that
 * Chromium can play back through `--use-file-for-fake-audio-capture`, so a test
 * run can dictate into the real app without ever opening the real microphone.
 *
 * The same three rules as generate-speaker-fixture.mjs apply, for the same
 * reasons:
 *
 *  - FROZEN once committed. The truth JSON carries the sha256 of the WAV, so a
 *    silent regeneration that changes the audio is detectable.
 *  - No downloads, ever. The Kokoro model must already be installed.
 *  - Deterministic. No RNG, and synthesis reproducibility is re-checked on
 *    every run.
 *
 * Shape of the clip, and why:
 *
 *   [lead silence] [sentence] [trailing silence]
 *
 * Chromium LOOPS the capture file. Padding the sentence with silence at both
 * ends means a recording that starts a little late or stops a little early
 * still contains exactly one clean pass of the sentence, instead of a clipped
 * word or a second half-sentence bleeding in from the loop point.
 *
 * Usage:
 *   node scripts/generate-dictation-fixture.mjs
 *   node scripts/generate-dictation-fixture.mjs --rate 48000 --out-dir /tmp/x
 *
 * Options:
 *   --rate <hz>      Output sample rate (default 16000, whisper.cpp's native
 *                    rate). Chromium's fake capture device is the other
 *                    consumer; if it ever rejects this rate, regenerate at the
 *                    rate it wants and update the truth file.
 *   --out-dir <dir>  Where to write (default tests/fixtures/dictation).
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const KokoroManager = require("../src/helpers/kokoro.js");

// ------------------------------------------------------------------- the clip

/** American female — the same HOST voice the multispeaker fixture uses. */
const VOICE = "af_heart";

/**
 * One plain sentence. Every word is common, there are no digits, no names and
 * no compounds, so whisper.cpp's base model has no orthographic excuse to
 * disagree with the truth text.
 *
 * "banana" is the word the Correction Memory gate rewrites. It is deliberately
 * a word no plausible mishearing turns into the replacement token, so a passing
 * run cannot be explained by the transcript having contained the target all
 * along.
 */
const SENTENCE = "I put the banana in my backpack yesterday.";

/**
 * The word a correction test targets, and what it must become. Written into the
 * truth file so the spec never hard-codes a second copy of the same strings.
 */
const CORRECTION_SOURCE = "banana";
const CORRECTION_TARGET = "Zephyr9000";

const LEAD_SILENCE_MS = 400;
const TRAIL_SILENCE_MS = 2500;

const DEFAULT_RATE = 16000;
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "tests", "fixtures", "dictation");
const CLIP_NAME = "banana";

// ------------------------------------------------------------------ resample

/** Normalized sinc: sin(pi x) / (pi x), with the removable singularity filled in. */
function sinc(x) {
  if (x === 0) return 1;
  const t = Math.PI * x;
  return Math.sin(t) / t;
}

/**
 * Windowed-sinc resampler, identical in behaviour to the one in
 * generate-speaker-fixture.mjs. Linear interpolation is wrong for 24000 ->
 * 16000: the Nyquist limit drops from 12kHz to 8kHz, and everything between
 * them folds back into the speech band as aliasing.
 */
function resample(input, inRate, outRate) {
  if (inRate === outRate) return Float32Array.from(input);

  const ratio = outRate / inRate;
  const outLength = Math.floor(input.length * ratio);
  const out = new Float32Array(outLength);

  const cutoff = Math.min(0.5, 0.5 * ratio) * 0.95;
  const halfWidth = 24;

  for (let i = 0; i < outLength; i += 1) {
    const center = i / ratio;
    const first = Math.ceil(center - halfWidth);
    const last = Math.floor(center + halfWidth);

    let acc = 0;
    let norm = 0;
    for (let j = first; j <= last; j += 1) {
      const u = center - j;
      const w =
        0.42 +
        0.5 * Math.cos((Math.PI * u) / halfWidth) +
        0.08 * Math.cos((2 * Math.PI * u) / halfWidth);
      const h = 2 * cutoff * sinc(2 * cutoff * u) * w;
      norm += h;
      if (j < 0 || j >= input.length) continue;
      acc += input[j] * h;
    }

    out[i] = norm !== 0 ? acc / norm : 0;
  }

  return out;
}

// ----------------------------------------------------------------- wav output

/** 16-bit PCM, mono, plain RIFF — the only WAV shape Chromium's fake device reads. */
function writeWav(filePath, samples, sampleRate) {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    pcm.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  fs.writeFileSync(filePath, Buffer.concat([header, pcm]));
  return pcm.length;
}

function sha256OfFloats(floats) {
  const view = Buffer.from(
    floats.buffer instanceof ArrayBuffer ? floats.buffer : new Float32Array(floats).buffer,
    floats.byteOffset || 0,
    floats.length * 4
  );
  return crypto.createHash("sha256").update(view).digest("hex");
}

function sha256OfFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

// ------------------------------------------------------------------ synthesis

function parseArgs(argv) {
  const args = { rate: DEFAULT_RATE, outDir: DEFAULT_OUT_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--rate" && argv[i + 1]) {
      args.rate = Number.parseInt(argv[i + 1], 10);
      i += 1;
    } else if (argv[i] === "--out-dir" && argv[i + 1]) {
      args.outDir = path.resolve(argv[i + 1]);
      i += 1;
    }
  }
  if (!Number.isFinite(args.rate) || args.rate <= 0) {
    throw new Error(`Invalid --rate: ${args.rate}`);
  }
  return args;
}

/** The voice ships inside kokoro-js. A missing one must fail loudly. */
function assertVoiceExists() {
  const voicePath = path.join(REPO_ROOT, "node_modules", "kokoro-js", "voices", `${VOICE}.bin`);
  if (!fs.existsSync(voicePath)) {
    throw new Error(`Kokoro voice missing: ${voicePath}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  assertVoiceExists();

  const kokoro = new KokoroManager();
  const status = await kokoro.checkModelStatus();
  if (!status.installed) {
    console.error(
      `Kokoro model is not installed at ${status.dir}. Missing: ${
        status.missingFiles.join(", ") || "everything"
      }.\nThis script never downloads. Install the model from the app first.`
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Kokoro model: ${status.dir}`);
  await kokoro.loadEngine();
  console.log(`Engine loaded in ${kokoro.getEngineStatus().coldStartMs}ms (fp32/cpu)`);

  fs.mkdirSync(args.outDir, { recursive: true });

  const spoken = await kokoro.synthesize(SENTENCE, { voice: VOICE, speed: 1.0 });
  console.log(`Kokoro native sample rate (measured, not assumed): ${spoken.sampleRate} Hz`);
  const firstHash = sha256OfFloats(spoken.pcm);

  const speech = resample(spoken.pcm, spoken.sampleRate, args.rate);
  const leadSamples = Math.round((LEAD_SILENCE_MS / 1000) * args.rate);
  const trailSamples = Math.round((TRAIL_SILENCE_MS / 1000) * args.rate);

  const audio = new Float32Array(leadSamples + speech.length + trailSamples);
  audio.set(speech, leadSamples);

  const wavPath = path.join(args.outDir, `${CLIP_NAME}.wav`);
  const truthPath = path.join(args.outDir, `${CLIP_NAME}.truth.json`);
  const bytes = writeWav(wavPath, audio, args.rate);
  const sha256 = sha256OfFile(wavPath);

  const truth = {
    clip: CLIP_NAME,
    voice: VOICE,
    text: SENTENCE,
    sampleRate: args.rate,
    channels: 1,
    bitsPerSample: 16,
    totalSamples: audio.length,
    totalSec: Number((audio.length / args.rate).toFixed(6)),
    speechStartSec: Number((leadSamples / args.rate).toFixed(6)),
    speechEndSec: Number(((leadSamples + speech.length) / args.rate).toFixed(6)),
    // What a spec is allowed to assert. `correctionSource` must survive
    // transcription; `correctionTarget` must never appear in a transcript that
    // Correction Memory has not rewritten.
    correctionSource: CORRECTION_SOURCE,
    correctionTarget: CORRECTION_TARGET,
    sha256,
    bytes: bytes + 44,
  };
  fs.writeFileSync(truthPath, `${JSON.stringify(truth, null, 2)}\n`);

  console.log("");
  console.log(
    `${CLIP_NAME}.wav  ${truth.totalSec.toFixed(3)}s  ${truth.bytes} bytes  ${args.rate} Hz mono pcm16`
  );
  console.log(`  text   "${SENTENCE}"`);
  console.log(
    `  speech ${truth.speechStartSec.toFixed(3)}s - ${truth.speechEndSec.toFixed(3)}s (${(
      truth.speechEndSec - truth.speechStartSec
    ).toFixed(3)}s spoken)`
  );
  console.log(`  sha256 ${sha256}`);

  // Kokoro is expected to be deterministic for a given input and voice.
  // Expected is not measured, so re-synthesize and compare.
  const repeat = await kokoro.synthesize(SENTENCE, { voice: VOICE, speed: 1.0 });
  const repeatHash = sha256OfFloats(repeat.pcm);
  console.log("");
  console.log(`DETERMINISM=${repeatHash === firstHash ? "match" : "MISMATCH"}`);
  console.log(`  first  ${firstHash}`);
  console.log(`  repeat ${repeatHash}`);
  if (repeatHash !== firstHash) {
    console.error("Kokoro synthesis is not reproducible on this machine; fixture is not frozen.");
    process.exitCode = 1;
  }

  console.log("");
  console.log(`Output: ${args.outDir}`);
  console.log(`Node ${process.version} on ${os.platform()} ${os.arch()}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
