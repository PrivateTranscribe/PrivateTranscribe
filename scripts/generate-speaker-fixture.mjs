#!/usr/bin/env node
/**
 * generate-speaker-fixture.mjs
 *
 * Builds the multi-speaker ground-truth fixture for Track C: a scripted
 * interview spoken by three Kokoro voices, plus a single-voice control clip,
 * each with a truth JSON giving every utterance's text, speaker and exact
 * start/end.
 *
 * The TTS testing the STT is the cheapest honest ground truth available: the
 * words and the boundaries are known because we wrote them, not because a
 * human listened and guessed.
 *
 * Three rules this file exists to enforce:
 *
 *  - The fixture is FROZEN once committed. A truth JSON that is subtly wrong
 *    poisons every later gate that measures against it, so nothing here may be
 *    "roughly" right. Boundaries come from sample offsets in the written file,
 *    never from a synthesis-time estimate.
 *  - No downloads, ever. KokoroManager refuses to load when the model is not
 *    on disk (allowRemoteModels=false), and this script refuses before that.
 *  - Deterministic. No RNG anywhere: the silence between utterances follows a
 *    fixed alternating pattern, and Kokoro's own synthesis is checked for
 *    reproducibility at the end of every run.
 *
 * Usage:
 *   node scripts/generate-speaker-fixture.mjs
 *   node scripts/generate-speaker-fixture.mjs --rate 24000 --out-dir /tmp/x
 *
 * Options:
 *   --rate <hz>      Output sample rate (default 16000, whisper.cpp's native
 *                    rate). 24000 writes Kokoro's own rate with no resampling,
 *                    which is what the resampler was measured against.
 *   --out-dir <dir>  Where to write (default tests/fixtures/multispeaker).
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

// ---------------------------------------------------------------- the script

/**
 * Fixed speaker -> voice mapping. Three clearly distinct voices: an American
 * female, an American male and a British female, so a later diarization gate is
 * separating voices that really are separable.
 */
const VOICES = {
  HOST: "af_heart",
  GUEST_A: "am_michael",
  GUEST_B: "bf_emma",
};

/**
 * English only, and deliberately plain: no digits, no hyphenated compounds and
 * no abbreviations, because every one of those is a place where Whisper and the
 * truth text can disagree about spelling without either being wrong. A coverage
 * number should measure hearing, not orthography.
 */
const INTERVIEW = [
  ["HOST", "Thanks for joining me. I want to hear how you both actually take notes in lectures."],
  ["GUEST_A", "Happy to be here. It started because my handwriting is slow and my professor talks fast."],
  ["HOST", "So you record the whole lecture?"],
  ["GUEST_A", "Not the whole thing. I keep the microphone off until something lands that I know I will forget."],
  ["GUEST_B", "That is the opposite of what I do. I record everything and sort it out afterwards."],
  ["HOST", "Does that not leave you with hours of audio to wade through?"],
  ["GUEST_B", "It would, if I left it as audio. The transcript is searchable, so I jump straight to the part I need."],
  ["HOST", "Why does it matter that it runs on your own machine?"],
  ["GUEST_A", "The lecture hall has terrible signal, and I did not want my own voice sitting on a server I have never heard of."],
  ["GUEST_B", "Half of my reading list is unpublished work, and I am not allowed to send it anywhere."],
  ["HOST", "How accurate is it with a strong accent?"],
  ["GUEST_A", "Better than I expected, though it still trips over names. I keep a list of terms from my field."],
  ["GUEST_B", "The first week was rough. Then I taught it the words it kept getting wrong, and it settled down."],
  ["HOST", "Is there anything you would still like it to do?"],
  ["GUEST_A", "I would like it to tell me who was speaking. In a seminar the transcript reads like one long paragraph."],
  ["GUEST_B", "And quicker on a laptop with no graphics card, because that is what most students carry."],
  ["HOST", "That is a fair place to stop. Thank you both."],
];

/** Single voice, single speaker. The baseline the existing pipeline is scored on. */
const CONTROL = [
  "I have been keeping my lecture notes this way for a couple of terms now, and I would not go back to the old way.",
  "The recorder sits on the desk and I only speak into it when something is worth keeping.",
  "Afterwards I read the transcript on the train home and mark the parts I did not understand.",
  "It is not perfect, and it never will be, but it is faster than writing everything by hand.",
  "The part I did not expect was how much it changed the way I listen in class.",
  "I am not trying to write down every word any more, so I can follow the argument instead.",
  "The first few days felt clumsy, and then it stopped feeling like a tool at all.",
  "If you are thinking about trying it, give it a full week before you decide.",
];

/**
 * Silence between utterances, alternating by utterance index. Deterministic on
 * purpose: an RNG here would make the fixture unreproducible, and "regenerate
 * it and see" is exactly the escape hatch a frozen fixture must not have.
 */
const GAP_PATTERN_MS = [450, 650];

const DEFAULT_RATE = 16000;
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "tests", "fixtures", "multispeaker");

// ------------------------------------------------------------------ resample

/** Normalized sinc: sin(pi x) / (pi x), with the removable singularity filled in. */
function sinc(x) {
  if (x === 0) return 1;
  const t = Math.PI * x;
  return Math.sin(t) / t;
}

/**
 * Windowed-sinc resampler.
 *
 * Linear interpolation was the cheaper option and is wrong for this direction:
 * 24000 -> 16000 drops the Nyquist limit from 12kHz to 8kHz, so everything
 * between them folds back into the speech band as aliasing. A Blackman-windowed
 * sinc with the cutoff placed just under the new Nyquist removes that content
 * instead of folding it.
 */
function resample(input, inRate, outRate) {
  if (inRate === outRate) return Float32Array.from(input);

  const ratio = outRate / inRate;
  const outLength = Math.floor(input.length * ratio);
  const out = new Float32Array(outLength);

  // Cutoff in cycles per input sample, capped just below the lower of the two
  // Nyquist limits so the transition band has somewhere to live.
  const cutoff = Math.min(0.5, 0.5 * ratio) * 0.95;
  // Half-width of the kernel in input samples. 24 taps a side is far more than
  // the fixture needs and costs about a second for two minutes of audio.
  const halfWidth = 24;

  for (let i = 0; i < outLength; i += 1) {
    const center = i / ratio;
    const first = Math.ceil(center - halfWidth);
    const last = Math.floor(center + halfWidth);

    let acc = 0;
    let norm = 0;
    for (let j = first; j <= last; j += 1) {
      const u = center - j;
      // Blackman window over [-halfWidth, halfWidth].
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

/**
 * 16-bit PCM, mono, plain RIFF. Float WAV would be lossless and unreadable to
 * half the tools that will ever open this file.
 */
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

/** The voices ship inside kokoro-js. A missing one must fail loudly, not silently substitute. */
function assertVoicesExist() {
  const voicesDir = path.join(REPO_ROOT, "node_modules", "kokoro-js", "voices");
  const missing = Object.values(VOICES).filter(
    (voice) => !fs.existsSync(path.join(voicesDir, `${voice}.bin`))
  );
  if (missing.length > 0) {
    throw new Error(`Kokoro voices missing from ${voicesDir}: ${missing.join(", ")}`);
  }
}

/**
 * Lay utterances end to end with a fixed silence between them, and read the
 * truth boundaries back out of the sample offsets in the buffer we are about to
 * write. Kokoro's own leading and trailing silence is left in place: the truth
 * describes the file as generated, and trimming would make the boundaries a
 * judgement call.
 */
function buildClip(pieces, rate) {
  const gapSamples = GAP_PATTERN_MS.map((ms) => Math.round((ms / 1000) * rate));

  let totalSamples = 0;
  pieces.forEach((piece, index) => {
    totalSamples += piece.samples.length;
    if (index < pieces.length - 1) totalSamples += gapSamples[index % gapSamples.length];
  });

  const audio = new Float32Array(totalSamples);
  const utterances = [];
  let cursor = 0;

  pieces.forEach((piece, index) => {
    audio.set(piece.samples, cursor);
    const startSample = cursor;
    cursor += piece.samples.length;
    utterances.push({
      index,
      speaker: piece.speaker,
      voice: piece.voice,
      text: piece.text,
      startSample,
      endSample: cursor,
      startSec: Number((startSample / rate).toFixed(6)),
      endSec: Number((cursor / rate).toFixed(6)),
    });
    if (index < pieces.length - 1) cursor += gapSamples[index % gapSamples.length];
  });

  return { audio, utterances, totalSamples };
}

function formatSeconds(value) {
  return value.toFixed(3).padStart(8);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  assertVoicesExist();

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

  let nativeRate = null;
  let firstHash = null;
  let firstText = null;
  let firstVoice = null;

  const synthesize = async (text, voice) => {
    const result = await kokoro.synthesize(text, { voice, speed: 1.0 });
    if (nativeRate === null) {
      nativeRate = result.sampleRate;
      console.log(`Kokoro native sample rate (measured, not assumed): ${nativeRate} Hz`);
    } else if (result.sampleRate !== nativeRate) {
      throw new Error(`Kokoro changed sample rate mid-run: ${nativeRate} -> ${result.sampleRate}`);
    }
    if (firstHash === null) {
      firstHash = sha256OfFloats(result.pcm);
      firstText = text;
      firstVoice = voice;
    }
    return resample(result.pcm, result.sampleRate, args.rate);
  };

  const clips = [];

  // --- interview -----------------------------------------------------------
  const interviewPieces = [];
  for (const [speaker, text] of INTERVIEW) {
    const voice = VOICES[speaker];
    if (!voice) throw new Error(`Unknown speaker in dialogue: ${speaker}`);
    process.stdout.write(".");
    interviewPieces.push({ speaker, voice, text, samples: await synthesize(text, voice) });
  }
  process.stdout.write("\n");
  clips.push({ name: "interview", ...buildClip(interviewPieces, args.rate) });

  // --- control -------------------------------------------------------------
  const controlPieces = [];
  for (const text of CONTROL) {
    process.stdout.write(".");
    controlPieces.push({
      speaker: "HOST",
      voice: VOICES.HOST,
      text,
      samples: await synthesize(text, VOICES.HOST),
    });
  }
  process.stdout.write("\n");
  clips.push({ name: "control", ...buildClip(controlPieces, args.rate) });

  // --- write ---------------------------------------------------------------
  for (const clip of clips) {
    const wavPath = path.join(args.outDir, `${clip.name}.wav`);
    const truthPath = path.join(args.outDir, `${clip.name}.truth.json`);
    const bytes = writeWav(wavPath, clip.audio, args.rate);
    const totalSec = Number((clip.totalSamples / args.rate).toFixed(6));

    const truth = {
      clip: clip.name,
      sampleRate: args.rate,
      totalSec,
      totalSamples: clip.totalSamples,
      utterances: clip.utterances,
    };
    fs.writeFileSync(truthPath, `${JSON.stringify(truth, null, 2)}\n`);

    console.log("");
    console.log(`${clip.name}.wav  ${totalSec.toFixed(3)}s  ${bytes + 44} bytes  ${args.rate} Hz`);
    console.log(`  sha256 ${sha256OfFile(wavPath)}`);
    console.log("  idx speaker      start      end      dur  text");
    for (const u of clip.utterances) {
      console.log(
        `  ${String(u.index).padStart(3)} ${u.speaker.padEnd(8)} ${formatSeconds(
          u.startSec
        )} ${formatSeconds(u.endSec)} ${formatSeconds(u.endSec - u.startSec)}  ${u.text.slice(0, 46)}`
      );
    }
    const spokenSec = clip.utterances.reduce((sum, u) => sum + (u.endSec - u.startSec), 0);
    console.log(
      `  utterances=${clip.utterances.length} spoken=${spokenSec.toFixed(3)}s silence=${(
        totalSec - spokenSec
      ).toFixed(3)}s`
    );
  }

  // --- determinism ---------------------------------------------------------
  // Kokoro is expected to be deterministic for a given input and voice. Expected
  // is not measured, so re-synthesize the first utterance and compare hashes.
  const repeat = await kokoro.synthesize(firstText, { voice: firstVoice, speed: 1.0 });
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
