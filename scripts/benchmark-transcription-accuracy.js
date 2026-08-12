#!/usr/bin/env node
/**
 * benchmark-transcription-accuracy.js
 *
 * Measures local Whisper accuracy on a real, public, reference-transcribed
 * speech set, so "model X is bad at language Y" becomes a number instead of an
 * impression.
 *
 * benchmarkManager.js measures speed. This measures whether the words are
 * right, which is the thing users actually complain about.
 *
 * Dataset: FLEURS (google/fleurs on HuggingFace, CC-BY-4.0) — read speech with
 * human reference transcripts in 102 languages. Downloaded once and cached
 * outside the repo.
 *
 * Usage:
 *   node scripts/benchmark-transcription-accuracy.js --language da
 *   node scripts/benchmark-transcription-accuracy.js --language da --models turbo,large --samples 50
 *   node scripts/benchmark-transcription-accuracy.js --language sv --samples 25
 *
 * Options:
 *   --language <code>   BCP-47 language to test (default: da)
 *   --models <list>     Comma-separated whisper model ids (default: every
 *                       downloaded model). Models that are not downloaded are
 *                       reported and skipped rather than silently ignored.
 *   --samples <n>       Utterances to score (default: 50, 0 = the whole set)
 *   --json <path>       Also write raw per-utterance results here
 *
 * The language is always pinned when transcribing. This measures transcription
 * quality, not language detection — those are separate failures and mixing
 * them is how you end up blaming the wrong component.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const WhisperManager = require("../src/helpers/whisper.js");
// ModelRegistry is TypeScript, so read the shared JSON the same way
// src/helpers/whisper.js does rather than pulling in a compile step.
const modelRegistryData = require("../src/models/modelRegistryData.json");

const getWhisperModels = () => modelRegistryData.whisperModels || {};

// FLEURS uses its own locale directory names. Only languages with a FLEURS
// split can be benchmarked; the error message lists what is available.
const FLEURS_LOCALES = {
  da: "da_dk",
  sv: "sv_se",
  no: "nb_no",
  nn: "nb_no",
  de: "de_de",
  nl: "nl_nl",
  fi: "fi_fi",
  is: "is_is",
  en: "en_us",
  fr: "fr_fr",
  es: "es_419",
  it: "it_it",
  pt: "pt_br",
  pl: "pl_pl",
  cs: "cs_cz",
  el: "el_gr",
  tr: "tr_tr",
  ru: "ru_ru",
  uk: "uk_ua",
  ar: "ar_eg",
  hi: "hi_in",
  ja: "ja_jp",
  ko: "ko_kr",
  zh: "cmn_hans_cn",
};

const FLEURS_BASE = "https://huggingface.co/datasets/google/fleurs/resolve/main/data";

const cacheRoot = () =>
  path.join(os.homedir(), ".cache", "PrivateTranscribe", "benchmarks", "fleurs");

function parseArgs(argv) {
  const args = { language: "da", models: null, samples: 50, json: null };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--language") ((args.language = value), (i += 1));
    else if (flag === "--models") ((args.models = value.split(",").map((m) => m.trim())), (i += 1));
    else if (flag === "--samples") ((args.samples = Number(value)), (i += 1));
    else if (flag === "--json") ((args.json = value), (i += 1));
    else if (flag === "--help") args.help = true;
  }
  return args;
}

/**
 * Word-level Levenshtein distance, the standard WER numerator.
 *
 * WER = (substitutions + deletions + insertions) / reference word count.
 */
function wordErrors(reference, hypothesis) {
  const ref = reference;
  const hyp = hypothesis;
  // Single-row DP: only the previous row is ever needed.
  let previous = Array.from({ length: hyp.length + 1 }, (_, i) => i);

  for (let i = 1; i <= ref.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= hyp.length; j += 1) {
      const substitution = previous[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      const deletion = previous[j] + 1;
      const insertion = current[j - 1] + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }
    previous = current;
  }

  return previous[hyp.length];
}

/**
 * Puts reference and hypothesis on the same footing before scoring.
 *
 * Whisper writes casing and punctuation; FLEURS references do not. Without
 * this every model would be penalised for formatting rather than for hearing
 * the wrong word. Letters outside ASCII are kept, so æ ø å survive.
 */
function normalizeForScoring(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[.,!?;:"“”„»«()[\]{}…]/g, " ")
    .replace(/[–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toWords(text) {
  const normalized = normalizeForScoring(text);
  return normalized ? normalized.split(" ") : [];
}

/** Counts extracted wavs, one level deep — the tarball nests them under test/. */
function countExtractedWavs(audioDir) {
  if (!fs.existsSync(audioDir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(audioDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".wav")) total += 1;
    else if (entry.isDirectory()) {
      total += fs
        .readdirSync(path.join(audioDir, entry.name))
        .filter((name) => name.endsWith(".wav")).length;
    }
  }
  return total;
}

function ensureDataset(locale) {
  const dir = path.join(cacheRoot(), locale);
  const tsvPath = path.join(dir, "test.tsv");
  const tarPath = path.join(dir, "test.tar.gz");
  const audioDir = path.join(dir, "audio");

  fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(tsvPath)) {
    console.log(`Downloading ${locale} reference transcripts...`);
    execFileSync("curl", ["-sL", "-o", tsvPath, `${FLEURS_BASE}/${locale}/test.tsv`], {
      stdio: "inherit",
    });
  }

  // Presence of the directory is not proof of a good extraction — a failed one
  // leaves an empty dir behind and would poison the cache for every later run.
  if (countExtractedWavs(audioDir) === 0) {
    if (!fs.existsSync(tarPath)) {
      console.log(`Downloading ${locale} audio (about 300-500 MB, cached after this)...`);
      execFileSync("curl", ["-L", "-o", tarPath, `${FLEURS_BASE}/${locale}/audio/test.tar.gz`], {
        stdio: "inherit",
      });
    }

    console.log("Extracting audio...");
    fs.mkdirSync(audioDir, { recursive: true });
    // Run tar from inside the target with a relative archive path. Passing a
    // Windows absolute path to `-C` extracts nothing and still exits 0.
    execFileSync("tar", ["-xzf", "../test.tar.gz"], { cwd: audioDir, stdio: "inherit" });

    const extracted = countExtractedWavs(audioDir);
    if (extracted === 0) {
      fs.rmSync(audioDir, { recursive: true, force: true });
      throw new Error(`Extraction produced no audio for ${locale}. Removed ${audioDir}; re-run.`);
    }
    console.log(`Extracted ${extracted} utterances.`);
  }

  return { tsvPath, audioDir };
}

/**
 * FLEURS test.tsv columns: id, filename, raw transcription, normalized
 * transcription, character split, then speaker metadata. Column 3 is the
 * reference used for scoring: already lowercased and depunctuated, which is
 * the convention FLEURS results are reported against.
 */
function loadSamples(tsvPath, audioDir, limit) {
  const rows = fs
    .readFileSync(tsvPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split("\t"));

  const found = [];
  for (const columns of rows) {
    const fileName = columns[1];
    const reference = columns[3] || columns[2];
    if (!fileName || !reference) continue;

    // The tarball may nest the wavs under a directory named for the split.
    const candidates = [
      path.join(audioDir, fileName),
      path.join(audioDir, "test", fileName),
      path.join(audioDir, path.basename(audioDir), fileName),
    ];
    const wavPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!wavPath) continue;

    found.push({ fileName, reference, wavPath });
    if (limit > 0 && found.length >= limit) break;
  }

  return found;
}

function resolveModels(manager, requested) {
  const registry = Object.keys(getWhisperModels());
  const wanted = requested && requested.length > 0 ? requested : registry;

  const available = [];
  const missing = [];
  for (const model of wanted) {
    if (!registry.includes(model)) {
      missing.push({ model, reason: "not a known model id" });
      continue;
    }
    const status = manager.getModelFileStatus(model);
    if (status.exists && status.valid) available.push(model);
    else missing.push({ model, reason: status.exists ? "file incomplete" : "not downloaded" });
  }

  return { available, missing, registry };
}

async function scoreModel(manager, model, samples, language) {
  const perUtterance = [];
  let totalErrors = 0;
  let totalWords = 0;
  const started = Date.now();

  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    const audio = fs.readFileSync(sample.wavPath);

    let hypothesis = "";
    try {
      const result = await manager.transcribeLocalWhisper(audio, {
        model,
        // Pinned on purpose: this measures transcription, not detection.
        language,
      });
      hypothesis = result?.text || "";
    } catch (error) {
      // A failed utterance counts as fully wrong rather than being dropped;
      // silently skipping failures flatters a model that crashes.
      hypothesis = "";
      perUtterance.push({ file: sample.fileName, error: error.message });
    }

    const refWords = toWords(sample.reference);
    const hypWords = toWords(hypothesis);
    const errors = wordErrors(refWords, hypWords);

    totalErrors += errors;
    totalWords += refWords.length;

    perUtterance.push({
      file: sample.fileName,
      reference: sample.reference,
      hypothesis,
      errors,
      words: refWords.length,
      wer: refWords.length ? errors / refWords.length : 0,
    });

    process.stdout.write(
      `\r  ${model}: ${i + 1}/${samples.length} utterances, running WER ${((totalErrors / Math.max(totalWords, 1)) * 100).toFixed(1)}%   `
    );
  }

  process.stdout.write("\n");

  return {
    model,
    wer: totalWords ? totalErrors / totalWords : 0,
    totalErrors,
    totalWords,
    utterances: samples.length,
    elapsedMs: Date.now() - started,
    perUtterance,
  };
}

/**
 * Runs the benchmark and returns the results, without printing a report or
 * touching the process exit code.
 *
 * Split out from the CLI so the CI regression gate
 * (scripts/check-accuracy-regression.js) measures with exactly the same code
 * path a developer runs by hand. A second implementation would drift, and a
 * regression gate that measures something slightly different from the
 * documented benchmark is worse than none.
 *
 * Throws rather than exiting, so a caller can decide what a missing model or
 * an empty dataset means for it.
 */
async function runBenchmark({ language, models = null, samples: sampleLimit = 50, quiet = false }) {
  const locale = FLEURS_LOCALES[language];
  if (!locale) {
    throw new Error(
      `No FLEURS split mapped for "${language}". Available: ${Object.keys(FLEURS_LOCALES).join(", ")}`
    );
  }

  const manager = new WhisperManager();
  if (!manager.serverManager.isAvailable()) {
    throw new Error("whisper-server binary not found. Run: npm run download:whisper-cpp");
  }

  const { available, missing, registry } = resolveModels(manager, models);

  if (missing.length > 0 && !quiet) {
    console.log("Skipping models that are not ready:");
    for (const entry of missing) console.log(`  - ${entry.model} (${entry.reason})`);
    console.log(`Known model ids: ${registry.join(", ")}`);
    console.log("Download more from the app's Settings, then re-run.\n");
  }

  if (available.length === 0) {
    throw new Error("No downloaded models to benchmark.");
  }

  const { tsvPath, audioDir } = ensureDataset(locale);
  const samples = loadSamples(tsvPath, audioDir, sampleLimit);

  if (samples.length === 0) {
    throw new Error(`No utterances found. Check the extracted audio under ${audioDir}`);
  }

  if (!quiet) {
    console.log(
      `\nFLEURS ${locale} — ${samples.length} utterances, language pinned to "${language}"`
    );
    console.log(`Models: ${available.join(", ")}\n`);
  }

  const results = [];
  for (const model of available) {
    results.push(await scoreModel(manager, model, samples, language));
  }

  try {
    await manager.serverManager.stop();
  } catch {
    // Best effort: the benchmark is done either way.
  }

  return { locale, language, sampleCount: samples.length, missing, results };
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(fs.readFileSync(__filename, "utf8").split("*/")[0]);
    return;
  }

  const { locale, sampleCount, results } = await runBenchmark({
    language: args.language,
    models: args.models,
    samples: args.samples,
  });

  results.sort((a, b) => a.wer - b.wer);

  console.log(`\nResults — lower WER is better\n`);
  console.log("| Model | WER | Word errors | Ref words | Time |");
  console.log("| --- | --- | --- | --- | --- |");
  for (const result of results) {
    console.log(
      `| ${result.model} | ${(result.wer * 100).toFixed(1)}% | ${result.totalErrors} | ${result.totalWords} | ${Math.round(result.elapsedMs / 1000)}s |`
    );
  }

  const best = results[0];
  for (const result of results.slice(1)) {
    const delta = (result.wer - best.wer) * 100;
    console.log(
      `\n${result.model} is ${delta.toFixed(1)} points worse than ${best.model} ` +
        `(${(result.wer * 100).toFixed(1)}% vs ${(best.wer * 100).toFixed(1)}%)`
    );
  }

  console.log(
    `\nCaveat: FLEURS is clean read speech, so these are best-case numbers and\n` +
      `absolute WER is inflated by number and spelling conventions. The gap\n` +
      `between models is the meaningful part, not the absolute value.`
  );

  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify({ locale, samples: sampleCount, results }, null, 2));
    console.log(`\nPer-utterance results written to ${args.json}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = {
  runBenchmark,
  wordErrors,
  normalizeForScoring,
  toWords,
  FLEURS_LOCALES,
};
