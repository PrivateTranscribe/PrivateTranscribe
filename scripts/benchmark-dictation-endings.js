#!/usr/bin/env node
"use strict";

// Local, opt-in real-engine benchmark. No microphone, clipboard, cloud calls,
// model downloads, or production settings writes. See the accompanying report.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Module = require("module");
const { spawnSync } = require("child_process");
const { buildCases, createWav, scoreCase } = require("./dictation-ending-benchmark-utils");
const ROOT = path.resolve(__dirname, "..");

function argument(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
}

function readPcm(file) {
  const result = spawnSync(
    require("ffmpeg-static"),
    ["-v", "error", "-i", file, "-ar", "16000", "-ac", "1", "-f", "s16le", "-"],
    { windowsHide: true, maxBuffer: 100 * 1024 * 1024, timeout: 60000 }
  );
  if (result.status !== 0) throw new Error(result.error?.message || result.stderr.toString());
  return result.stdout;
}

function loadBaseline(revision) {
  const result = spawnSync("git", ["show", `${revision}:src/helpers/whisperServer.js`], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr);
  // Resolve its imports beside the real helper, without changing any files.
  // Only whisperServer differs between these variants; all other code is current.
  const filename = path.join(ROOT, "src/helpers/whisperServer.js");
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(result.stdout, filename);
  return loaded.exports;
}

function prepareExperimentalAudio(pcm, modelPath, mode = "tail") {
  const { Vad } = require("sherpa-onnx-node");
  const samples = new Float32Array(pcm.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
  const detector = new Vad(
    {
      sileroVad: {
        model: modelPath,
        threshold: 0.3,
        minSilenceDuration: 0.5,
        minSpeechDuration: 0.15,
        windowSize: 512,
        maxSpeechDuration: 60,
      },
      sampleRate: 16000,
      numThreads: 1,
      provider: "cpu",
      debug: 0,
    },
    90
  );
  let end = null;
  const regions = [];
  const drain = () => {
    while (!detector.isEmpty()) {
      const segment = detector.front();
      end = segment.start + segment.samples.length;
      const region = [Math.max(0, segment.start - 8000), Math.min(samples.length, end + 8000)];
      const last = regions.at(-1);
      if (last && region[0] <= last[1]) last[1] = Math.max(last[1], region[1]);
      else regions.push(region);
      detector.pop();
    }
  };
  for (let i = 0; i < samples.length; i += 512) {
    detector.acceptWaveform(samples.subarray(i, i + 512));
    drain();
  }
  detector.flush();
  drain();
  // No detection is not proof of no speech. Leave the existing standalone
  // non-speech checks in charge rather than deleting an unrecognised recording.
  if (end === null) return pcm;
  if (mode === "tail") return pcm.subarray(0, Math.min(samples.length, end + 8000) * 2);
  // Leave uninterrupted speech alone. Reprocessing an already clean recording
  // can change Whisper's words without addressing either reported defect.
  const hasLongGap = regions.some(([start], i) => start - (regions[i - 1]?.[1] || 0) > 32000);
  const hasNoiseTail = samples.length - regions.at(-1)[1] > 32000;
  if (mode === "cleanup" && !hasLongGap && !hasNoiseTail) return pcm;
  const speech = Buffer.concat(
    regions.flatMap(([start, stop]) => [pcm.subarray(start * 2, stop * 2), Buffer.alloc(16000)])
  );
  const normalized = spawnSync(
    require("ffmpeg-static"),
    [
      "-v",
      "error",
      "-i",
      "pipe:0",
      "-af",
      "dynaudnorm=f=150:g=5:m=50:r=0.2:p=0.95",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-f",
      "s16le",
      "-",
    ],
    { input: createWav(speech), windowsHide: true, maxBuffer: 100 * 1024 * 1024, timeout: 60000 }
  );
  if (normalized.status !== 0)
    throw new Error(normalized.error?.message || normalized.stderr.toString());
  return normalized.stdout;
}

async function main() {
  const fixtureDir = path.join(ROOT, "tests/fixtures/dictation");
  const longDir = path.join(ROOT, "tmp/long-dictation-test");
  const baseline = argument("baseline", null);
  const output = path.resolve(
    argument("output", path.join(ROOT, "tmp/dictation-endings-benchmark"))
  );
  const models = argument("models", "turbo,large").split(",");
  const repetitions = Number(argument("repeats", "1"));
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10)
    throw new Error("repeats must be 1 through 10");
  const vadModel = argument("vad-model", null);
  const vadMode = argument("vad-mode", "tail");
  if (!["tail", "cleanup", "cleanup-all"].includes(vadMode))
    throw new Error("vad-mode must be tail, cleanup, or cleanup-all");
  if (vadModel && !fs.existsSync(vadModel)) throw new Error("VAD model does not exist");
  const cudaDir = argument("cuda-dir", null);
  if (cudaDir) {
    if (!fs.existsSync(cudaDir)) throw new Error("CUDA directory does not exist");
    require("../src/helpers/gpuBinaryManager").prototype.getBinDir = () => path.resolve(cudaDir);
  }
  const Whisper = require("../src/helpers/whisper");
  const CurrentServer = require("../src/helpers/whisperServer");
  const variants = [];
  if (baseline) variants.push({ name: "before", Server: loadBaseline(baseline) });
  variants.push({ name: "current", Server: CurrentServer });
  if (vadModel)
    variants.push({ name: `experimental-speech-${vadMode}`, Server: CurrentServer, vad: true });
  if (process.argv.includes("--candidate-only")) variants.splice(0, variants.length - 1);
  const cases = buildCases({
    speech: readPcm(path.join(longDir, "long-dictation-fixture.wav")),
    manifest: JSON.parse(
      fs.readFileSync(path.join(longDir, "long-dictation-fixture.manifest.json"))
    ),
    banana: readPcm(path.join(fixtureDir, "banana.wav")),
    breath: readPcm(path.join(fixtureDir, "breath.wav")),
    thanks: readPcm(path.join(fixtureDir, "thank-you.wav")),
  }).filter((c) => !argument("case", "") || c.name.includes(argument("case", "")));
  if (!cases.length) throw new Error("No matching cases");
  fs.mkdirSync(output, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    baseline,
    models,
    repetitions,
    vadMode,
    vadSha256: vadModel
      ? crypto.createHash("sha256").update(fs.readFileSync(vadModel)).digest("hex")
      : null,
    cases: cases.map(({ pcm, ...c }) => ({
      ...c,
      seconds: pcm.length / 32000,
      sha256: crypto.createHash("sha256").update(createWav(pcm)).digest("hex"),
    })),
    results: [],
  };
  for (const c of cases) fs.writeFileSync(path.join(output, `${c.name}.wav`), createWav(c.pcm));
  for (const model of models)
    for (const variant of variants) {
      const manager = new Whisper();
      manager.serverManager = new variant.Server();
      try {
        for (let repetition = 1; repetition <= repetitions; repetition++)
          for (const c of cases) {
            const start = Date.now();
            try {
              const pcm = variant.vad ? prepareExperimentalAudio(c.pcm, vadModel, vadMode) : c.pcm;
              const result = await manager.transcribeLocalWhisper(createWav(pcm), {
                model,
                language: "en",
                inputFileName: "benchmark.wav",
                trimTrailingSilence: true,
              });
              const text = result.text || "";
              const score = scoreCase(c, text);
              report.results.push({
                model,
                variant: variant.name,
                repetition,
                case: c.name,
                elapsedMs: Date.now() - start,
                computeMode: result.computeMode,
                inferenceDurationMs: result.inferenceDurationMs,
                text,
                score,
              });
              console.log(
                JSON.stringify({
                  model,
                  variant: variant.name,
                  repetition,
                  case: c.name,
                  passed: score.passed,
                  endingRecall: score.boundaryResults[0].recall,
                  wordErrorRate: score.wordErrorRate,
                  unexpectedThanks: score.unexpectedThanks,
                  missingThanks: score.missingThanks,
                })
              );
            } catch (error) {
              report.results.push({
                model,
                variant: variant.name,
                repetition,
                case: c.name,
                error: error.message,
                score: { passed: false },
              });
              console.error(`${model} ${variant.name} ${c.name}: ${error.message}`);
            }
            fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(report, null, 2));
          }
      } finally {
        await manager.serverManager.stop();
      }
    }
  console.log(`Results saved in ${output}`);
  // Baseline failures are expected. Only the selected candidate controls exit.
  const candidate = variants.at(-1).name;
  if (report.results.some((r) => r.variant === candidate && !r.score.passed)) process.exitCode = 1;
}

if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = { prepareExperimentalAudio, readPcm };
