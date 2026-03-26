#!/usr/bin/env node
"use strict";

/**
 * Smart Context pipeline benchmark — measures context-enrichment overhead.
 *
 * Unlike benchmark-transcription.js (which times whisper.cpp inference),
 * this script focuses on the context pipeline itself: how much latency
 * each context stage adds to prompt assembly.
 *
 * Usage:
 *   node scripts/benchmark-context.js [--runs 5] [--quiet]
 *
 * Stages timed per scenario (averaged over --runs iterations):
 *   context-prep    – validate / build the ContextResult object
 *   whisper-hint    – buildWhisperContextHint (initialPrompt text)
 *   file-id-extract – extractIdentifiers on fixture source content
 *   hint-assemble   – buildFileIdentifierHint
 *   prompt-assemble – concatenate base text + all context hints
 *
 * Scenarios:
 *   A. baseline         – no context, prompt-assemble only
 *   B. window-context   – window title + app name
 *   C. window+file-ids  – window title + app name + file identifiers
 *
 * Simulated vs live:
 *   All context data comes from built-in fixture inputs. This script does NOT
 *   call IPC or read the live OS window. It measures only the pure computation
 *   overhead of the context pipeline helpers.
 */

const { performance } = require("perf_hooks");

// ── Inlined pure helpers from contextPipeline.js ─────────────────────────────
//
// contextPipeline.js is ESM and transitively imports logger.ts (TypeScript),
// making it impossible to `require()` or dynamically `import()` from a plain
// Node CJS script without a bundler. These three pure functions have no
// dependencies and are copied verbatim so the benchmark stays self-contained.
//
// If the production implementations change, update these copies too.

const WHISPER_TITLE_MAX = 80;

const FILENAME_TITLE_PATTERNS = [
  /^([\w][\w. -]*\.\w+)\s*[—–]/,
  /^([\w][\w. -]*\.\w+)\s+-\s+\w/,
  /^([\w][\w. -]*\.\w+)\s+\[/,
];

/**
 * Parse a filename from a window title. (mirrors contextPipeline.parseFilenameFromTitle)
 * @param {string|null|undefined} windowTitle
 * @returns {string|null}
 */
function parseFilenameFromTitle(windowTitle) {
  if (!windowTitle) return null;
  const trimmed = windowTitle.trim();
  for (const pattern of FILENAME_TITLE_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (match) return match[1].trim();
  }
  return null;
}

/**
 * Build terse hint for Whisper initialPrompt. (mirrors contextPipeline.buildWhisperContextHint)
 * @param {object|null|undefined} ctx
 * @returns {string|null}
 */
function buildWhisperContextHint(ctx) {
  if (!ctx?.available) return null;
  const parts = [];
  const appLabel = ctx.appName || ctx.processName || ctx.appClass || null;
  if (appLabel) parts.push(`App: ${appLabel}`);
  if (ctx.windowTitle) {
    const title =
      ctx.windowTitle.length > WHISPER_TITLE_MAX
        ? ctx.windowTitle.slice(0, WHISPER_TITLE_MAX - 3) + "..."
        : ctx.windowTitle;
    parts.push(`Window: ${title}`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Build terse file-identifier hint. (mirrors contextPipeline.buildFileIdentifierHint)
 * @param {object|null|undefined} fileCtx
 * @returns {string|null}
 */
function buildFileIdentifierHint(fileCtx) {
  if (!fileCtx?.available || !fileCtx.identifiers?.length) return null;
  const sample = fileCtx.identifiers.slice(0, 15).join(" ");
  return `Identifiers: ${sample}`;
}

// ── CLI args ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`
  node scripts/benchmark-context.js [options]

  Options:
    --runs  <n>   Number of iterations per scenario (default: 5)
    --quiet       Suppress per-row table; only print summary
    --help        Show this message

  Note: all context data is SIMULATED (no live OS/IPC calls).
  `);
  process.exit(0);
}

function getArg(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

const RUNS = Math.max(1, parseInt(getArg("--runs") || "5", 10));
const QUIET = argv.includes("--quiet");

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Simulate a typical developer window title (VS Code with em-dash). */
const FIXTURE_WINDOW_TITLE =
  "contextPipeline.js \u2014 privoca [~/projects/privoca/src/helpers] - VSCodium";

const FIXTURE_APP_NAME = "VSCodium";

/**
 * Tiny synthetic source snippet representative of what the identifier extractor
 * would process from a real file (~250 bytes, well under the 500 KB limit).
 */
const FIXTURE_SOURCE_CONTENT = `
function buildWhisperContextHint(ctx) {
  const windowTitle = ctx?.windowTitle ?? "";
  const appName = ctx?.appName ?? ctx?.processName ?? "";
  return [appName, windowTitle].filter(Boolean).join(": ");
}
const extractFileIdentifiers = async (windowTitle, options) => {
  const filename = parseFilenameFromTitle(windowTitle);
  return filename ? { available: true, identifiers: [] } : null;
};
`.trim();

/** Base dictation text used for all prompt-assembly timing. */
const FIXTURE_BASE_TEXT =
  "Today I want to update the context pipeline module to fix the timeout handling.";

// ── Pure helper functions (exported for tests) ─────────────────────────────

/**
 * Time a synchronous function.
 *
 * @template T
 * @param {() => T} fn
 * @returns {{ result: T, elapsedMs: number }}
 */
function timeSync(fn) {
  const t0 = performance.now();
  const result = fn();
  return { result, elapsedMs: performance.now() - t0 };
}

/**
 * Time an async function.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<{ result: T, elapsedMs: number }>}
 */
async function timeAsync(fn) {
  const t0 = performance.now();
  const result = await fn();
  return { result, elapsedMs: performance.now() - t0 };
}

/**
 * Build the ordered set of scenario fixture objects used by the benchmark.
 *
 * @returns {Array<{
 *   id: string,
 *   label: string,
 *   simulated: true,
 *   context: object|null,
 *   sourceContent: string|null
 * }>}
 */
function buildScenarios() {
  return [
    {
      id: "baseline",
      label: "Baseline (no context)",
      simulated: true,
      context: null,
      sourceContent: null,
    },
    {
      id: "window-context",
      label: "Window title + app name",
      simulated: true,
      context: {
        available: true,
        source: "fixture",
        windowTitle: FIXTURE_WINDOW_TITLE,
        appName: FIXTURE_APP_NAME,
        processName: FIXTURE_APP_NAME,
        bundleId: null,
        platform: "linux",
      },
      sourceContent: null,
    },
    {
      id: "window-file-ids",
      label: "Window + file identifiers",
      simulated: true,
      context: {
        available: true,
        source: "fixture",
        windowTitle: FIXTURE_WINDOW_TITLE,
        appName: FIXTURE_APP_NAME,
        processName: FIXTURE_APP_NAME,
        bundleId: null,
        platform: "linux",
      },
      sourceContent: FIXTURE_SOURCE_CONTENT,
    },
  ];
}

/**
 * Assemble the final Whisper/reasoning prompt by joining base text and hints.
 *
 * @param {string}   baseText  Transcribed or draft text.
 * @param {string[]} hints     Ordered context hint strings (empty strings filtered out).
 * @returns {string}
 */
function assembleFinalPrompt(baseText, hints) {
  const valid = (hints || []).filter((h) => typeof h === "string" && h.trim().length > 0);
  return valid.length === 0 ? baseText : [baseText, ...valid].join("\n");
}

/**
 * Format stage-level timing rows into a human-readable table string.
 *
 * @param {Array<{ scenario: string, stage: string, elapsedMs: number }>} rows
 * @returns {string}
 */
function formatTable(rows) {
  const C_SCENARIO = 32;
  const C_STAGE = 20;
  const C_TIME = 10;

  const header = [
    "Scenario".padEnd(C_SCENARIO),
    "Stage".padEnd(C_STAGE),
    "Avg ms".padStart(C_TIME),
  ].join("  ");

  const divider = "-".repeat(header.length);

  const dataRows = rows.map((r) =>
    [
      r.scenario.padEnd(C_SCENARIO),
      r.stage.padEnd(C_STAGE),
      r.elapsedMs.toFixed(4).padStart(C_TIME),
    ].join("  "),
  );

  return [divider, header, divider, ...dataRows, divider].join("\n");
}

/**
 * Format per-scenario total overhead into a summary table string.
 *
 * @param {Record<string, number>} totals  Map of scenario label → total ms.
 * @returns {string}
 */
function formatSummary(totals) {
  const C_SCENARIO = 32;
  const C_TIME = 16;

  const header = [
    "Scenario".padEnd(C_SCENARIO),
    "Total overhead (ms)".padStart(C_TIME),
  ].join("  ");

  const divider = "=".repeat(header.length);

  const rows = Object.entries(totals).map(([label, ms]) =>
    [label.padEnd(C_SCENARIO), ms.toFixed(4).padStart(C_TIME)].join("  "),
  );

  return [divider, header, divider, ...rows, divider].join("\n");
}

/**
 * Compute incremental overhead of each non-baseline scenario vs the baseline.
 *
 * @param {Record<string, number>} totals
 * @param {string} baselineLabel
 * @returns {Array<{ label: string, deltaMs: number }>}
 */
function computeIncrementalOverhead(totals, baselineLabel) {
  const base = totals[baselineLabel] ?? 0;
  return Object.entries(totals)
    .filter(([label]) => label !== baselineLabel)
    .map(([label, ms]) => ({ label, deltaMs: ms - base }));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // CJS require for fileIdentifierExtractor (main-process helper).
  let extractIdentifiers;
  try {
    ({ extractIdentifiers } = require("../src/helpers/fileIdentifierExtractor.js"));
  } catch (err) {
    console.error("[benchmark-context] Cannot require fileIdentifierExtractor.js:", err.message);
    process.exit(1);
  }

  console.log("\n=== Smart Context Pipeline Benchmark ===");
  console.log(`Runs per scenario : ${RUNS}`);
  console.log("Context data      : SIMULATED (fixture inputs — no live OS/IPC calls)\n");

  const scenarios = buildScenarios();
  const allRows = [];
  const totals = {};

  for (const scenario of scenarios) {
    const stageTotals = {};

    for (let run = 0; run < RUNS; run++) {
      // Stage 1: context-prep
      const { elapsedMs: prepMs } = timeSync(() => {
        if (!scenario.context) return null;
        return {
          available: scenario.context.available,
          windowTitle: scenario.context.windowTitle ?? "",
          appName: scenario.context.appName ?? scenario.context.processName ?? "",
        };
      });
      stageTotals["context-prep"] = (stageTotals["context-prep"] ?? 0) + prepMs;

      // Stage 2: whisper-hint
      const { result: whisperHint, elapsedMs: whisperHintMs } = timeSync(() =>
        scenario.context ? buildWhisperContextHint(scenario.context) : null,
      );
      stageTotals["whisper-hint"] = (stageTotals["whisper-hint"] ?? 0) + whisperHintMs;

      // Stage 3: file-id-extract
      let fileIdentifiers = [];
      const { elapsedMs: fileIdMs } = timeSync(() => {
        if (scenario.sourceContent) {
          fileIdentifiers = extractIdentifiers(scenario.sourceContent);
        }
      });
      stageTotals["file-id-extract"] = (stageTotals["file-id-extract"] ?? 0) + fileIdMs;

      // Stage 4: hint-assemble
      const fileIdCtx =
        fileIdentifiers.length > 0
          ? { available: true, identifiers: fileIdentifiers }
          : null;
      const { result: fileHint, elapsedMs: hintAssembleMs } = timeSync(() =>
        fileIdCtx ? buildFileIdentifierHint(fileIdCtx) : null,
      );
      stageTotals["hint-assemble"] = (stageTotals["hint-assemble"] ?? 0) + hintAssembleMs;

      // Stage 5: prompt-assemble
      const { elapsedMs: promptMs } = timeSync(() =>
        assembleFinalPrompt(FIXTURE_BASE_TEXT, [whisperHint, fileHint].filter(Boolean)),
      );
      stageTotals["prompt-assemble"] = (stageTotals["prompt-assemble"] ?? 0) + promptMs;
    }

    // Average across runs and accumulate rows
    let scenarioTotal = 0;
    for (const [stage, total] of Object.entries(stageTotals)) {
      const avgMs = total / RUNS;
      scenarioTotal += avgMs;
      allRows.push({ scenario: scenario.label, stage, elapsedMs: avgMs });
    }
    totals[scenario.label] = scenarioTotal;
  }

  // Output
  if (!QUIET) {
    console.log(formatTable(allRows));
    console.log();
  }

  console.log("Per-scenario totals (all stages combined, averaged over runs):");
  console.log(formatSummary(totals));

  const BASELINE_LABEL = "Baseline (no context)";
  const incremental = computeIncrementalOverhead(totals, BASELINE_LABEL);
  if (incremental.length > 0) {
    console.log("\nIncremental overhead vs baseline:");
    for (const { label, deltaMs } of incremental) {
      const sign = deltaMs >= 0 ? "+" : "";
      console.log(`  ${label}: ${sign}${deltaMs.toFixed(4)} ms`);
    }
  }

  console.log("\nNote: pure computation only — IPC round-trip latency not included.");
  console.log("Done.\n");
}

// ── Exports (for tests) ───────────────────────────────────────────────────────

module.exports = {
  // Benchmark-specific helpers
  timeSync,
  timeAsync,
  buildScenarios,
  assembleFinalPrompt,
  formatTable,
  formatSummary,
  computeIncrementalOverhead,
  // Inlined pure functions from contextPipeline.js (no Electron/TS deps needed)
  parseFilenameFromTitle,
  buildWhisperContextHint,
  buildFileIdentifierHint,
  // Fixtures
  FIXTURE_WINDOW_TITLE,
  FIXTURE_APP_NAME,
  FIXTURE_SOURCE_CONTENT,
  FIXTURE_BASE_TEXT,
};

// Run when executed directly
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
