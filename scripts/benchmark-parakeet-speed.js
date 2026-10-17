#!/usr/bin/env node
"use strict";

/**
 * Parakeet CPU speed gate — times parakeet-tdt-0.6b-v3 on this machine with the
 * same client, thread policy and 1.5 s bar as the in-app speed test, so CI can
 * judge a laptop-sized runner before Parakeet becomes the default without a GPU.
 *
 * Usage: node scripts/benchmark-parakeet-speed.js [--runs 5] [--prepare-only]
 *   --runs <n>      speed tests per round; the median decides (default 5)
 *   --prepare-only  download and verify the model when missing, then exit
 *
 * A first round whose median is over the bar earns one more round, and the
 * median of both rounds decides (see judgeDecodes). Exit code 1 when that
 * median exceeds the bar or the engine fails, else 0. Plain Node: the engine
 * runs in a child_process.
 */

const fs = require("fs");
const os = require("os");
const ParakeetManager = require("../src/helpers/parakeet");
const ParakeetClient = require("../src/helpers/parakeetClient");
const { warmCpuTopology } = require("../src/helpers/cpuThreads");

const { DEFAULT_MODEL, SPEED_TEST_THRESHOLD_MS, resolveParakeetThreads, resolveBenchmarkWavPath } =
  ParakeetClient;

const argv = process.argv.slice(2);

function getArg(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

const RUNS = Math.max(1, Number.parseInt(getArg("--runs") || "5", 10) || 5);
const PREPARE_ONLY = argv.includes("--prepare-only");

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// Shared-runner noise only ever slows a decode, and it comes in bursts that can
// lift a whole round: on 17 Oct 2026 a version-bump commit measured a 1524 ms
// median and its rerun 1199 ms. So a slow first round gets one more round, and
// the median of all the decodes decides. A real slowdown is slow in both rounds
// and still fails; judging on the minimum instead would loosen the bar 3-5 %.
function judgeDecodes(decodes, { barMs, roundSize }) {
  const med = median(decodes);
  if (med <= barMs) return { verdict: "pass", median: med };
  if (decodes.length < 2 * roundSize) return { verdict: "remeasure", median: med };
  return { verdict: "fail", median: med };
}

// downloadFile checks the registry's pinned SHA-256 before the archive is used.
async function ensureModel(manager) {
  const modelDir = manager.getModelPath(DEFAULT_MODEL);
  if (manager.isModelDownloaded(DEFAULT_MODEL)) {
    console.log(`Model: cached at ${modelDir}`);
    return;
  }
  console.log(`Model: missing, downloading ${DEFAULT_MODEL} (SHA-256 pinned in the registry)`);
  const startedAt = Date.now();
  let lastPct = -1;
  await manager.downloadParakeetModel(DEFAULT_MODEL, (progress) => {
    if (progress.type === "progress" && progress.percentage >= lastPct + 10) {
      lastPct = progress.percentage;
      console.log(`  ${progress.percentage}%`);
    }
  });
  if (!manager.isModelDownloaded(DEFAULT_MODEL)) {
    throw new Error(`Model files missing after download: ${modelDir}`);
  }
  console.log(`Model: downloaded and verified in ${Math.round((Date.now() - startedAt) / 1000)} s`);
}

async function describeMachine() {
  const cpus = os.cpus();
  const physicalCores = await warmCpuTopology();
  return {
    cpuModel: (cpus[0]?.model || "unknown").trim(),
    logicalCores: cpus.length,
    physicalCores,
    threads: resolveParakeetThreads(physicalCores),
    memoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
  };
}

function writeStepSummary(report) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const { machine, decodes, med, passed, transcribe, loadMs, rounds } = report;
  const lines = [
    `## Parakeet CPU speed: ${passed ? "pass" : "FAIL"}`,
    "",
    `Median decode of the ${report.audioSec.toFixed(1)} s clip: **${med} ms** ` +
      `(bar ${SPEED_TEST_THRESHOLD_MS} ms, ${decodes.length} runs in ${rounds} round${rounds === 1 ? "" : "s"})`,
    "",
    "| | |",
    "|---|---|",
    `| CPU | ${machine.cpuModel} |`,
    `| Cores | ${machine.physicalCores} physical, ${machine.logicalCores} logical |`,
    `| Threads used | ${report.threadsUsed} |`,
    `| Memory | ${machine.memoryGb} GB |`,
    `| Model load | ${loadMs ?? "n/a"} ms |`,
    `| Decode min / median / max | ${Math.min(...decodes)} / ${med} / ${Math.max(...decodes)} ms |`,
    `| All decodes | ${decodes.join(", ")} ms |`,
    `| Full pipeline (warm, incl. ffmpeg prep) | ${transcribe ? `${transcribe.totalMs} ms` : "failed"} |`,
    "",
    // The clip ends mid-word, so the text is a sanity check, never an accuracy score.
    `Text (speed only; the clip ends mid-word): ${transcribe?.text ? `"${transcribe.text}"` : "none"}`,
    "",
  ];
  fs.appendFileSync(summaryPath, lines.join("\n"));
}

async function main() {
  const manager = new ParakeetManager();
  await ensureModel(manager);
  if (PREPARE_ONLY) return 0;

  const machine = await describeMachine();
  console.log(`CPU: ${machine.cpuModel}`);
  console.log(
    `Cores: ${machine.physicalCores} physical, ${machine.logicalCores} logical; ` +
      `threads: ${machine.threads}; memory: ${machine.memoryGb} GB; ${machine.platform}, node ${machine.node}`
  );

  const client = new ParakeetClient({ getModelDir: (name) => manager.getModelPath(name) });
  try {
    const decodes = [];
    let audioSec = 0;
    let rounds = 0;
    let judgement;
    do {
      rounds++;
      for (let run = 1; run <= RUNS; run++) {
        const result = await client.speedTest(DEFAULT_MODEL);
        if (!result.success) {
          console.error(`Speed test ${run} failed: ${result.error} ${result.message || ""}`);
          return 1;
        }
        audioSec = result.audioSec;
        decodes.push(result.decodeMs);
        console.log(`Speed test ${run}/${RUNS} (round ${rounds}): ${result.decodeMs} ms`);
      }
      judgement = judgeDecodes(decodes, { barMs: SPEED_TEST_THRESHOLD_MS, roundSize: RUNS });
      if (judgement.verdict === "remeasure") {
        console.log(
          `Round 1 median ${judgement.median} ms is over the bar; measuring ${RUNS} more ` +
            "before judging, since runner noise can lift a whole round"
        );
      }
    } while (judgement.verdict === "remeasure");
    const loadMs = client.lastLoadMs;
    const threadsUsed = client.numThreads ?? machine.threads;

    let transcribe = null;
    try {
      const wav = await fs.promises.readFile(resolveBenchmarkWavPath());
      const startedAt = performance.now();
      const result = await client.transcribe(wav, { model: DEFAULT_MODEL });
      transcribe = { totalMs: Math.round(performance.now() - startedAt), text: result.text || "" };
      console.log(`Full pipeline (warm): ${transcribe.totalMs} ms`);
      console.log(`Text: ${transcribe.text || "(none)"}`);
    } catch (error) {
      // Reported, but the gate is the decode median; the in-app speed test times the same.
      console.error(`Full-pipeline transcribe failed: ${error.message}`);
    }

    const med = judgement.median;
    const passed = judgement.verdict === "pass";
    console.log(
      `Decode of ${audioSec.toFixed(1)} s audio: min ${Math.min(...decodes)} / median ${med} / ` +
        `max ${Math.max(...decodes)} ms (load ${loadMs ?? "n/a"} ms, threads ${threadsUsed})`
    );
    console.log(
      `${passed ? "PASS" : "FAIL"}: median ${med} ms of ${decodes.length} decodes vs bar ${SPEED_TEST_THRESHOLD_MS} ms`
    );

    writeStepSummary({
      machine,
      decodes,
      med,
      passed,
      transcribe,
      loadMs,
      audioSec,
      threadsUsed,
      rounds,
    });
    return passed ? 0 : 1;
  } finally {
    await client.stop();
  }
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    })
    .finally(() => {
      // A stray child or handle must not hang a CI job; stop() has already run.
      setTimeout(() => process.exit(process.exitCode ?? 1), 10_000).unref();
    });
}

module.exports = { median, judgeDecodes };
