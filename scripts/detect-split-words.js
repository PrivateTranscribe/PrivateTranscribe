#!/usr/bin/env node
/**
 * detect-split-words.js
 *
 * Counts one specific transcription defect: Whisper writing a single word as
 * two or more space-separated fragments ("u de" for "ude", "adgangs gebyrer"
 * for "adgangsgebyrer").
 *
 * WER already counts these, but it counts them the same as any other wrong
 * word, so a language that splits constantly and a language that mishears
 * constantly produce the same number. This separates them, because the fixes
 * are not the same fix.
 *
 * Detection: a run of 2-4 adjacent hypothesis words whose concatenation is a
 * word in the reference, where the reference does not contain that same run as
 * separate words. The second condition is what keeps genuine two-word phrases
 * out - if the reference also writes them apart, nothing was split.
 *
 * Usage:
 *   node scripts/detect-split-words.js --language da --model turbo --samples 150
 *   node scripts/detect-split-words.js --language en --model turbo --samples 150
 *   node scripts/detect-split-words.js --language da --prompt "OpenCode, RTX 3090"
 *
 * Options:
 *   --language <code>  BCP-47 language, pinned on every request (default: da)
 *   --model <id>       Whisper model id (default: turbo)
 *   --samples <n>      Utterances to score (default: 150, 0 = whole set)
 *   --prompt <text>    Send this as Whisper's initial prompt, the way the app
 *                      sends the custom dictionary
 *   --label <text>     Name for this leg in the report and the JSON
 *   --json <path>      Write raw per-utterance results here
 */

const fs = require("fs");
const path = require("path");

const WhisperManager = require("../src/helpers/whisper.js");
const {
  toWords,
  FLEURS_LOCALES,
  ensureDataset,
  loadSamples,
} = require("./benchmark-transcription-accuracy.js");

// Danish compounds split into at most a handful of pieces in practice. Looking
// wider mostly manufactures coincidences out of short function words.
const MAX_FRAGMENTS = 4;

function parseArgs(argv) {
  const args = {
    language: "da",
    model: "turbo",
    samples: 150,
    prompt: null,
    label: null,
    json: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--language") ((args.language = value), (i += 1));
    else if (flag === "--model") ((args.model = value), (i += 1));
    else if (flag === "--samples") ((args.samples = Number(value)), (i += 1));
    else if (flag === "--prompt") ((args.prompt = value), (i += 1));
    else if (flag === "--label") ((args.label = value), (i += 1));
    else if (flag === "--json") ((args.json = value), (i += 1));
  }
  return args;
}

/**
 * Returns the words this hypothesis split, as { wrote, expected } pairs.
 *
 * Longer runs are tried first and their positions are then consumed, so
 * "a d gangs" is reported once as a three-fragment split rather than also
 * being counted again as the two-fragment split hiding inside it.
 */
function findSplits(reference, hypothesis) {
  const refWords = toWords(reference);
  const hypWords = toWords(hypothesis);
  const refSet = new Set(refWords);
  const refRun = ` ${refWords.join(" ")} `;

  const splits = [];
  const consumed = new Set();

  for (let n = MAX_FRAGMENTS; n >= 2; n -= 1) {
    for (let i = 0; i + n <= hypWords.length; i += 1) {
      let overlaps = false;
      for (let k = i; k < i + n; k += 1) if (consumed.has(k)) overlaps = true;
      if (overlaps) continue;

      const fragments = hypWords.slice(i, i + n);
      const joined = fragments.join("");
      if (!refSet.has(joined)) continue;
      // The reference writes these apart too, so this is an ordinary phrase,
      // not a word that got broken up.
      if (refRun.includes(` ${fragments.join(" ")} `)) continue;

      for (let k = i; k < i + n; k += 1) consumed.add(k);
      splits.push({ wrote: fragments.join(" "), expected: joined, fragments: n });
    }
  }

  return splits;
}

async function run() {
  const args = parseArgs(process.argv);
  const locale = FLEURS_LOCALES[args.language];
  if (!locale) {
    throw new Error(
      `No FLEURS split for "${args.language}". Available: ${Object.keys(FLEURS_LOCALES).join(", ")}`
    );
  }

  const label = args.label || `${args.language}/${args.model}${args.prompt ? "/prompted" : ""}`;
  const { tsvPath, audioDir } = ensureDataset(locale);
  const samples = loadSamples(tsvPath, audioDir, args.samples);
  if (samples.length === 0) throw new Error(`No cached utterances for ${locale}.`);

  const manager = new WhisperManager();
  const status = manager.getModelFileStatus(args.model);
  if (!status.exists || !status.valid) {
    throw new Error(`Model "${args.model}" is not downloaded and complete.`);
  }

  console.log(`\n${label}: ${samples.length} utterances, model ${args.model}`);
  if (args.prompt) console.log(`  initial prompt: ${args.prompt}`);

  const perUtterance = [];
  const tally = new Map();
  let totalSplits = 0;
  let totalRefWords = 0;
  let failures = 0;
  const started = Date.now();

  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    let hypothesis = "";
    try {
      const result = await manager.transcribeLocalWhisper(fs.readFileSync(sample.wavPath), {
        model: args.model,
        language: args.language,
        initialPrompt: args.prompt || null,
      });
      hypothesis = result?.text || "";
    } catch (error) {
      // A failed utterance cannot be scored either way. Counted and reported
      // rather than folded into the rate, which would understate it.
      failures += 1;
      perUtterance.push({ file: sample.fileName, error: error.message });
      continue;
    }

    const splits = findSplits(sample.reference, hypothesis);
    const refWords = toWords(sample.reference).length;

    totalSplits += splits.length;
    totalRefWords += refWords;
    for (const split of splits) {
      const key = `${split.wrote} -> ${split.expected}`;
      tally.set(key, (tally.get(key) || 0) + 1);
    }

    perUtterance.push({
      file: sample.fileName,
      reference: sample.reference,
      hypothesis,
      splits,
      words: refWords,
    });

    process.stdout.write(`\r  ${i + 1}/${samples.length}, ${totalSplits} split words so far   `);
  }
  process.stdout.write("\n");

  await manager.stopServer();

  const scored = perUtterance.filter((entry) => !entry.error);
  const affected = scored.filter((entry) => entry.splits.length > 0).length;
  const rate = totalRefWords ? (totalSplits / totalRefWords) * 100 : 0;

  const summary = {
    label,
    language: args.language,
    model: args.model,
    prompt: args.prompt || null,
    utterances: scored.length,
    failures,
    referenceWords: totalRefWords,
    splitWords: totalSplits,
    splitsPer100Words: Number(rate.toFixed(3)),
    utterancesAffected: affected,
    utterancesAffectedPct: scored.length
      ? Number(((affected / scored.length) * 100).toFixed(1))
      : 0,
    elapsedMs: Date.now() - started,
  };

  console.log(`\n  split words:        ${totalSplits} in ${totalRefWords} reference words`);
  console.log(`  rate:               ${rate.toFixed(2)} per 100 words`);
  console.log(
    `  utterances hit:     ${affected}/${scored.length} (${summary.utterancesAffectedPct}%)`
  );
  if (failures) console.log(`  failed utterances:  ${failures}`);

  const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  if (top.length) {
    console.log("\n  most frequent splits:");
    for (const [key, count] of top) console.log(`    ${count}x  ${key}`);
  }

  if (args.json) {
    fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
    fs.writeFileSync(args.json, JSON.stringify({ summary, perUtterance }, null, 2));
    console.log(`\n  wrote ${args.json}`);
  }

  return summary;
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`\n${error.message}`);
    process.exit(1);
  });
}

module.exports = { findSplits };
