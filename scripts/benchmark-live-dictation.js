#!/usr/bin/env node
/**
 * benchmark-live-dictation.js
 *
 * How long a dictation leaves the user waiting after they press stop, and how
 * many words it gets wrong, in two shapes:
 *
 *   at stop   The whole recording is transcribed after stop, the way every
 *             dictation under the long-session threshold is.
 *   live      The recording is promoted to a long session after --promote
 *             seconds. Segments rotate at the first pause after 60 s (600 ms
 *             under RMS 0.015, as audioManager.js polls it), capped at 90 s,
 *             and each is transcribed while the next is still being recorded.
 *             Only what is still queued at stop is waited for.
 *
 * The wait for "live" is simulated from measured decode times: segment i is
 * ready when its audio ends, starts once the previous one has finished, and
 * the wait is when the last one finishes minus when recording stopped. So a
 * CPU that falls behind the speaker shows up as a longer wait.
 *
 * Audio is FLEURS speech (see benchmark-file-pieces.js) at -26 dBFS with
 * dictation-length pauses and quiet room noise. It covers the decode path
 * through the real WhisperManager, not MediaRecorder capture or pasting.
 *
 * Usage:
 *   node scripts/benchmark-live-dictation.js --cuda
 *   node scripts/benchmark-live-dictation.js --cpu --model base --lengths 90,150
 *
 * Options:
 *   --language <code>   FLEURS language (default da)
 *   --model <name>      Whisper model id (default turbo)
 *   --lengths <list>    Recording lengths in seconds (default 90,150,240)
 *   --promote <s>       Promotion threshold for the live shape (default 60)
 *   --promote-cut <how> "pause" waits for a pause before the first cut,
 *                       "clock" cuts at the threshold (default pause)
 *   --pause-hold <s>    How long a pause must last before a cut (default 0.6)
 *   --cuda / --cpu      Engine, as in benchmark-file-pieces.js
 */

const path = require("path");
const WhisperManager = require("../src/helpers/whisper.js");
const { createPcm16WavBuffer, parseWavPcmInfo } = require("../src/helpers/wavPcm.js");
const { buildFixture, score } = require("./benchmark-file-pieces.js");

const SAMPLE_RATE = 16000;
// Pauses a person leaves while dictating: mostly short, the odd long think.
const DICTATION_PAUSES = [0.4, 0.8, 0.5, 1.2, 0.6, 2.0, 0.45, 0.7];
// Mirrors audioManager.js.
const SEGMENT_SECONDS = 60;
const SEGMENT_MAX_SECONDS = 90;
const PAUSE_POLL_SECONDS = 0.1;
let PAUSE_HOLD_SECONDS = 0.6;
const PAUSE_RMS = 0.015;

function parseArgs(argv) {
  const args = {
    language: "da",
    model: "turbo",
    lengths: [90, 150, 240],
    promote: 60,
    promoteCut: "pause",
    cuda: false,
    cpu: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === "--language" && value) args.language = argv[++i];
    else if (flag === "--model" && value) args.model = argv[++i];
    else if (flag === "--lengths" && value) args.lengths = argv[++i].split(",").map(Number);
    else if (flag === "--promote" && value) args.promote = Number(argv[++i]);
    else if (flag === "--promote-cut" && value) args.promoteCut = argv[++i];
    else if (flag === "--pause-hold" && value) PAUSE_HOLD_SECONDS = Number(argv[++i]);
    else if (flag === "--cuda") args.cuda = true;
    else if (flag === "--cpu") args.cpu = true;
  }
  return args;
}

function rmsAt(pcm, second) {
  const from = Math.floor(second * SAMPLE_RATE) * 2;
  const to = Math.min(pcm.length, from + Math.floor(PAUSE_POLL_SECONDS * SAMPLE_RATE) * 2);
  let squares = 0;
  let count = 0;
  for (let i = from; i + 2 <= to; i += 2) {
    const value = pcm.readInt16LE(i) / 32768;
    squares += value * value;
    count += 1;
  }
  return count ? Math.sqrt(squares / count) : 0;
}

// Where the live recorder would cut: the first held pause after `after`
// seconds into the segment, or the cap.
function nextCut(pcm, segmentStart, after, cap, total) {
  let held = 0;
  for (let t = segmentStart + after; t < total; t += PAUSE_POLL_SECONDS) {
    if (t - segmentStart >= cap) return t;
    held = rmsAt(pcm, t) < PAUSE_RMS ? held + PAUSE_POLL_SECONDS : 0;
    if (held >= PAUSE_HOLD_SECONDS - 1e-9) return t;
  }
  return total;
}

function liveSegments(pcm, total, promote, promoteCut) {
  if (total <= promote) return [[0, total]];
  const first =
    promoteCut === "clock"
      ? promote
      : nextCut(pcm, 0, promote, Math.max(promote, SEGMENT_MAX_SECONDS), total);
  const segments = [[0, first]];
  let start = first;
  while (start < total - 1e-6) {
    const end = nextCut(pcm, start, SEGMENT_SECONDS, SEGMENT_MAX_SECONDS, total);
    segments.push([start, end]);
    start = end;
  }
  return segments;
}

function slice(pcm, from, to) {
  return createPcm16WavBuffer(
    pcm.subarray(Math.floor(from * SAMPLE_RATE) * 2, Math.floor(to * SAMPLE_RATE) * 2)
  );
}

async function timed(manager, wav, options) {
  const started = Date.now();
  const result = await manager.transcribeLocalWhisper(wav, {
    inputFileName: "dictation.wav",
    ...options,
  });
  return { text: String(result?.text || "").trim(), seconds: (Date.now() - started) / 1000 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.cuda) {
    const GpuBinaryManager = require("../src/helpers/gpuBinaryManager.js");
    const binDir = path.join(process.env.APPDATA || "", "PrivateTranscribe", "bin");
    GpuBinaryManager.prototype.getBinDir = () => binDir;
  }
  const manager = new WhisperManager();
  if (args.cpu) await manager.serverManager.setForceCpu(true);
  const base = { model: args.model, language: args.language };

  console.log(
    `model ${args.model}  language ${args.language}  promote ${args.promote}s (${args.promoteCut} cut)`
  );
  try {
    const warm = buildFixture(args.language, 0.1, -55, -26, DICTATION_PAUSES, { unique: true });
    await timed(manager, warm.wav, { ...base, trimTrailingSilence: true });
    console.log(`engine ${manager.serverManager.getEngineStatus().effectiveEngine}\n`);

    for (const seconds of args.lengths) {
      const fixture = buildFixture(args.language, seconds / 60, -55, -26, DICTATION_PAUSES, {
        unique: true,
      });
      const info = parseWavPcmInfo(fixture.wav);
      const pcm = fixture.wav.subarray(info.dataOffset, info.dataOffset + info.dataSize);
      const total = info.durationSeconds;

      const atStop = await timed(manager, fixture.wav, { ...base, trimTrailingSilence: true });

      let finished = 0;
      const texts = [];
      const segments = liveSegments(pcm, total, args.promote, args.promoteCut);
      for (const [from, to] of segments) {
        const run = await timed(manager, slice(pcm, from, to), {
          ...base,
          longSessionChunk: true,
          trimTrailingSilence: true,
        });
        finished = Math.max(finished, to) + run.seconds;
        texts.push(run.text);
      }
      const live = { text: texts.filter(Boolean).join(" "), wait: finished - total };

      const a = score(fixture.reference, atStop.text);
      const b = score(fixture.reference, live.text);
      const cuts = segments.map(([, to]) => to.toFixed(1)).join(" ");
      console.log(`${total.toFixed(0)} s recording, cuts at ${cuts}`);
      console.log(
        `  at stop  wait ${atStop.seconds.toFixed(1)} s  WER ${(a.wer * 100).toFixed(1)}%  (${a.errors}/${a.refWords})`
      );
      console.log(
        `  live     wait ${live.wait.toFixed(1)} s  WER ${(b.wer * 100).toFixed(1)}%  (${b.errors}/${b.refWords})`
      );
    }
  } finally {
    await manager.serverManager?.stop?.().catch?.(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
