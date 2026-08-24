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
 * Every pair is measured in each mode the config lists. Pinning the language
 * measures transcription alone and is blind to language detection by
 * construction, so the config also asks for the constrained mode the
 * spoken-languages setting puts users on. Modes are separate baseline entries,
 * because they answer different questions and averaging them would let one
 * hide the other.
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

  // Pinned alone is blind to language detection by construction, so the gate
  // also measures the constrained path the spoken-languages setting puts every
  // user on. A detection regression shows up there as a WER cliff.
  const modes = config.modes ?? ["pinned"];
  const spokenLanguages = config.spokenLanguages ?? [];

  // Measured flat, one entry per language/model/mode, so the baseline stays
  // readable in a diff and a single entry can be added without reshaping it.
  const results = [];
  for (const target of config.targets) {
    console.log(`\n=== ${target.language} (${target.models.join(", ")}) x ${modes.join(", ")} ===`);
    const run = await runBenchmark({
      language: target.language,
      models: target.models,
      samples: config.samples ?? 50,
      modes,
      spokenLanguages,
      quiet: true,
    });

    for (const result of run.results) {
      // Detection accuracy is logged but not gated: a detection failure always
      // shows up as a WER cliff, and gating two numbers on one run would make
      // the failure harder to read, not easier.
      const detected =
        result.languageAccuracy === null
          ? ""
          : `, correct language on ${(result.languageAccuracy * 100).toFixed(0)}% of ` +
            `${result.detectionsReported} reported detections`;
      console.log(
        `  ${result.model} ${result.mode}: ${(result.wer * 100).toFixed(1)}% WER${detected}`
      );
      results.push({
        language: target.language,
        model: result.model,
        mode: result.mode,
        wer: Number(result.wer.toFixed(4)),
        utterances: result.utterances,
        ...(result.languageAccuracy === null
          ? {}
          : {
              languageAccuracy: Number(result.languageAccuracy.toFixed(4)),
              detectionsReported: result.detectionsReported,
            }),
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
          modes,
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

  // Measured, not theorised: moving the same models and audio from a Windows
  // CUDA machine to a Linux CPU runner shifted English by 0.9-1.5 points and
  // Danish by 3.5-4.8. A cross-platform comparison is therefore not a
  // meaningful regression signal, and silently producing one wasted a full CI
  // run before this warning existed.
  const baselinePlatform = baseline.measuredOn?.platform;
  if (baselinePlatform && baselinePlatform !== process.platform) {
    console.warn(
      `\nWARNING: baseline was measured on ${baselinePlatform}, this is ${process.platform}.\n` +
        `Backends disagree by several WER points, more so outside English, so treat\n` +
        `differences below as platform drift rather than a real change. Compare like\n` +
        `for like before believing a regression.`
    );
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
