#!/usr/bin/env node

/*
  Branding audit
  - Finds legacy product names in the repo (e.g. OpenWhispr / DictateVoice)
  - Intended to support the ongoing rebranding to Privoca

  Usage:
    node scripts/audit-branding.js
*/

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");

const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  "out",
  // These directories often contain large or binary files.
  path.join("resources", "bin"),
  path.join("src", "dist"),
]);

const NEEDLES = [
  { label: "OpenWhispr", re: /OpenWhispr/g },
  { label: "DictateVoice", re: /DictateVoice/g },
  { label: "Dictate Voice", re: /Dictate Voice/g },
  { label: "openwhispr (case-insensitive)", re: /openwhispr/gi },
  { label: "dictatevoice (case-insensitive)", re: /dictatevoice/gi },
];

function isExcludedDir(relativeDir) {
  if (EXCLUDED_DIRS.has(relativeDir)) return true;

  // Exclude any nested directory under excluded roots.
  for (const ex of EXCLUDED_DIRS) {
    if (relativeDir === ex) return true;
    if (relativeDir.startsWith(ex + path.sep)) return true;
  }

  return false;
}

function isProbablyBinary(buffer) {
  // Heuristic: if it contains NUL bytes, treat as binary.
  return buffer.includes(0);
}

function* walkFiles(dir, relativeDir = "") {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = relativeDir ? path.join(relativeDir, entry.name) : entry.name;

    if (entry.isDirectory()) {
      if (isExcludedDir(rel)) continue;
      yield* walkFiles(abs, rel);
    } else if (entry.isFile()) {
      yield { abs, rel };
    }
  }
}

function scanFile(absPath) {
  let buf;
  try {
    buf = fs.readFileSync(absPath);
  } catch {
    return [];
  }

  if (isProbablyBinary(buf)) return [];

  const text = buf.toString("utf8");
  const hits = [];

  for (const needle of NEEDLES) {
    needle.re.lastIndex = 0;
    const matches = text.match(needle.re);
    if (matches && matches.length > 0) {
      hits.push({ label: needle.label, count: matches.length });
    }
  }

  return hits;
}

function main() {
  const perFile = [];
  const totals = new Map();

  const selfRelPath = path.relative(REPO_ROOT, __filename);

  for (const { abs, rel } of walkFiles(REPO_ROOT)) {
    if (rel === selfRelPath) continue;
    const hits = scanFile(abs);
    if (hits.length === 0) continue;

    perFile.push({ file: rel, hits });
    for (const h of hits) {
      totals.set(h.label, (totals.get(h.label) || 0) + h.count);
    }
  }

  if (perFile.length === 0) {
    console.log("Branding audit: no legacy names found.");
    process.exit(0);
  }

  console.log("Branding audit: legacy name occurrences found.\n");

  console.log("Totals:");
  for (const [label, count] of Array.from(totals.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`- ${label}: ${count}`);
  }

  console.log("\nFiles:");
  for (const row of perFile.sort((a, b) => a.file.localeCompare(b.file))) {
    const summary = row.hits.map((h) => `${h.label}=${h.count}`).join(", ");
    console.log(`- ${row.file}: ${summary}`);
  }

  console.log("\nTip: update references in the files above as part of the Privoca rebrand.");
}

main();
