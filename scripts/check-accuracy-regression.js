#!/usr/bin/env node
/**
 * check-accuracy-regression.js
 *
 * Fails when local transcription accuracy gets worse. This is the gate that
 * stops a Danish regression from shipping unnoticed, which is exactly how the
 * last one shipped.
 *
 * Measures the pairs listed in benchmarks/accuracy-config.json using the same
 * code path as scripts/benchmark-transcription-accuracy.js, then compares the
 * result against benchmarks/accuracy-baseline.json.
 *
 * Usage:
 *   node scripts/check-accuracy-regression.js
 *   node scripts/check-accuracy-regression.js --update-baseline
 *   node scripts/check-accuracy-regression.js --tolerance 2.0
 *   node scripts/check-accuracy-regression.js --config <path> --baseline <path>
 *
 * The --config and --baseline overrides exist so the gate can be pointed at a
 * small fixture and watched to fail. A gate nobody has seen fail is
 * indistinguishable from one that cannot.
 *
 * IMPORTANT: refresh the baseline on the same kind of machine that runs the
 * gate. WER is stable for a given model, audio and decoder, but backends do
 * differ, and a baseline recorded on a CUDA laptop can sit a little off from
 * a CPU-only runner. Committing a baseline measured somewhere else turns the
 * gate into noise, which is worse than not having one.
 */

const fs = require("fs");
const path = require("path");

const { runBenchmark } = require("./benchmark-transcription-accuracy.js");
const { compareToBaseline, formatComparison } = require("./lib/accuracy-regression.js");

const BENCHMARK_DIR = path.join(__dirname, "..", "benchmarks");
const CONFIG_PATH = path.join(BENCHMARK_DIR, "accuracy-config.json");
const BASELINE_PATH = path.join(BENCHMARK_DIR, "accuracy-baseline.json");

function parseArgs(argv) {
  const args = { updateBaseline: false, tolerance: null, config: null, baseline: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--update-baseline") args.updateBaseline = true;
    else if (argv[i] === "--tolerance") {
      args.tolerance = Number(argv[i + 1]);
      i += 1;
    } else if (argv[i] === "--config") {
      // Overridable so the gate itself can be exercised against a small,
      // deliberately failing fixture. A gate nobody has ever seen fail is
      // indistinguishable from one that cannot fail.
      args.config = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--baseline") {
      args.baseline = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function main() {
  const args = parseArgs(process.argv);
  const configPath = args.config ? path.resolve(args.config) : CONFIG_PATH;
  const baselinePath = args.baseline ? path.resolve(args.baseline) : BASELINE_PATH;
  const config = readJson(configPath, null);

  if (!config) {
    console.error(`Missing ${configPath}`);
    process.exit(1);
  }

  const tolerancePoints = args.tolerance ?? config.tolerancePoints ?? 1.5;

  // Measured flat, one entry per language/model pair, so the baseline stays
  // readable in a diff and a single pair can be added without reshaping it.
  const results = [];
  for (const target of config.targets) {
    console.log(`\n=== ${target.language} (${target.models.join(", ")}) ===`);
    const run = await runBenchmark({
      language: target.language,
      models: target.models,
      samples: config.samples ?? 50,
      quiet: true,
    });

    for (const result of run.results) {
      console.log(`  ${result.model}: ${(result.wer * 100).toFixed(1)}% WER`);
      results.push({
        language: target.language,
        model: result.model,
        wer: Number(result.wer.toFixed(4)),
        utterances: result.utterances,
      });
    }

    // A model the runner failed to download would otherwise silently shrink
    // coverage, and the gate would pass by measuring less.
    if (run.missing.length > 0) {
      console.error(
        `  Not measured: ${run.missing.map((entry) => `${entry.model} (${entry.reason})`).join(", ")}`
      );
    }
  }

  if (args.updateBaseline) {
    fs.mkdirSync(BENCHMARK_DIR, { recursive: true });
    fs.writeFileSync(
      baselinePath,
      `${JSON.stringify(
        {
          // Recorded so a confusing failure can be traced to a baseline
          // measured somewhere other than where the gate runs.
          measuredOn: { platform: process.platform, arch: process.arch },
          samples: config.samples ?? 50,
          entries: results,
        },
        null,
        2
      )}\n`
    );
    console.log(`\nBaseline written to ${baselinePath}`);
    console.log("Commit it only if this machine matches where the gate runs.");
    return;
  }

  const baseline = readJson(baselinePath, null);
  if (!baseline) {
    console.error(`\nNo baseline at ${baselinePath}.`);
    console.error("Create one with: node scripts/check-accuracy-regression.js --update-baseline");
    process.exit(1);
  }

  const comparison = compareToBaseline(results, baseline.entries, { tolerancePoints });

  console.log("");
  for (const line of formatComparison(comparison, { tolerancePoints })) {
    console.log(line);
  }

  if (!comparison.ok) {
    console.error("\nAccuracy gate failed.");
    process.exit(1);
  }

  console.log("\nAccuracy gate passed.");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
