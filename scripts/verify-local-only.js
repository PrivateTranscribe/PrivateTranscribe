#!/usr/bin/env node
/**
 * verify-local-only.js
 *
 * Turns "your audio stays on your PC" from a claim into an observation.
 *
 * Runs one local Whisper transcription headlessly and samples the operating
 * system's connection table throughout, filtered to the transcription process
 * tree. Every remote endpoint that tree holds is classified as loopback or
 * external. An external endpoint fails the run.
 *
 * Headless on purpose. It reads a WAV from disk instead of the microphone and
 * never touches the clipboard or the foreground window, so it cannot type into
 * whatever you happen to have focused.
 *
 * The sampler runs in its own process. An in-process sampler was starved for
 * 1.3 seconds while whisper-server spawned, which put the blind spot at exactly
 * the moment a phone-home would occur. A separate process cannot be blocked by
 * the main thread's work.
 *
 * Usage:
 *   node scripts/verify-local-only.js
 *   node scripts/verify-local-only.js --model small --out docs/goal-evidence
 *
 * Options:
 *   --model <id>   Whisper model to use (default: base)
 *   --audio <path> WAV to transcribe (default: resources/benchmark.wav)
 *   --out <dir>    Where to write the evidence files (default: docs/goal-evidence)
 *
 * What this establishes, and what it does not:
 *
 *   Does     The transcription tree held no connection to any address off this
 *            machine at any sampled moment, and produced a transcript anyway.
 *   Does not It samples rather than intercepts. A connection opened and closed
 *            entirely inside one sampling gap would be missed. The report
 *            states the observed gap distribution so that hole is visible
 *            rather than assumed.
 *
 * The conclusive companion test blocks the app outbound at the Windows firewall
 * and confirms local transcription still completes. That needs an elevated
 * prompt, so it is documented in the report rather than run here.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile, execFileSync, spawn } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const TREE_REFRESH_MS = 300;

/**
 * Loopback covers more than 127.0.0.1. The whole 127/8 block is loopback, as
 * are IPv6 ::1 and the v4-mapped form. 0.0.0.0 and :: are listening wildcards
 * rather than destinations.
 */
function classifyRemote(address) {
  const addr = String(address)
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (addr === "*" || addr === "0.0.0.0" || addr === "::" || addr === "") return "listening";
  if (addr === "::1" || /^127\./.test(addr) || /^::ffff:127\./.test(addr)) return "loopback";
  return "external";
}

/** One `netstat -ano` sample, parsed into the rows we care about. */
function sampleConnections() {
  const raw = execFileSync("netstat", ["-ano"], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const [proto, , remote] = parts;
    if (proto !== "TCP" && proto !== "UDP") continue;
    const pid = Number(parts[parts.length - 1]);
    if (!Number.isInteger(pid)) continue;
    rows.push({
      proto,
      remote,
      // TCP rows carry a state column before the PID; UDP rows do not.
      state: proto === "TCP" ? parts[3] : "",
      pid,
      remoteHost: remote.replace(/:[^:]*$/, ""),
    });
  }
  return rows;
}

function buildTree(rootPid, out) {
  let procs;
  try {
    procs = JSON.parse(out);
  } catch {
    return null;
  }
  if (!Array.isArray(procs)) procs = [procs];

  const childrenOf = new Map();
  const nameOf = new Map();
  for (const p of procs) {
    if (!childrenOf.has(p.ParentProcessId)) childrenOf.set(p.ParentProcessId, []);
    childrenOf.get(p.ParentProcessId).push(p.ProcessId);
    nameOf.set(p.ProcessId, p.Name);
  }

  const tree = new Set();
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.pop();
    if (tree.has(pid)) continue;
    tree.add(pid);
    for (const child of childrenOf.get(pid) ?? []) queue.push(child);
  }
  return { tree, nameOf };
}

function processTree(rootPid) {
  return new Promise((resolve) => {
    execFile(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, out) => resolve(err ? null : buildTree(rootPid, out))
    );
  });
}

/**
 * Sampler mode. Runs as its own process so the parent's blocking work cannot
 * starve it. Emits one JSON line per sample and exits on SIGTERM.
 */
async function runSampler(rootPid, outPath) {
  const stream = fs.createWriteStream(outPath, { flags: "a" });
  let tracked = new Set([rootPid]);
  let nameOf = new Map();
  let running = true;

  const stop = () => {
    running = false;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  let refreshing = false;
  const refresh = () => {
    if (refreshing) return;
    refreshing = true;
    processTree(rootPid)
      .then((r) => {
        if (r?.tree) {
          // The sampler is itself a child of the root. Exclude it so its own
          // presence can never be mistaken for the app's behaviour.
          r.tree.delete(process.pid);
          tracked = r.tree;
          nameOf = r.nameOf;
        }
      })
      .finally(() => {
        refreshing = false;
      });
  };
  const timer = setInterval(refresh, TREE_REFRESH_MS);
  refresh();

  while (running) {
    const at = Date.now();
    let rows;
    try {
      rows = sampleConnections();
    } catch {
      await new Promise((r) => setImmediate(r));
      continue;
    }
    const external = [];
    const loopback = [];
    for (const row of rows) {
      if (!tracked.has(row.pid)) continue;
      const kind = classifyRemote(row.remoteHost);
      if (kind === "external") {
        external.push({ ...row, name: nameOf.get(row.pid) ?? "?" });
      } else if (kind === "loopback" && row.state === "ESTABLISHED") {
        loopback.push(`${row.proto} ${row.remote}`);
      }
    }
    stream.write(`${JSON.stringify({ at, external, loopback })}\n`);
    await new Promise((r) => setImmediate(r));
  }

  clearInterval(timer);
  await new Promise((r) => stream.end(r));
  process.exit(0);
}

function parseArgs(argv) {
  const args = { model: "base", audio: "resources/benchmark.wav", out: "docs/goal-evidence" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--audio") args.audio = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const audioPath = path.resolve(REPO_ROOT, args.audio);
  if (!fs.existsSync(audioPath)) throw new Error(`Audio not found: ${audioPath}`);

  const audio = fs.readFileSync(audioPath);
  const audioSha = crypto.createHash("sha256").update(audio).digest("hex");

  console.log("\nverify-local-only");
  console.log(`  audio   ${path.relative(REPO_ROOT, audioPath)} (${audio.length} bytes)`);
  console.log(`  sha256  ${audioSha}`);
  console.log(`  model   ${args.model}\n`);

  const samplePath = path.join(os.tmpdir(), `pt-local-only-${process.pid}.jsonl`);
  fs.writeFileSync(samplePath, "");
  const sampler = spawn(
    process.execPath,
    [__filename, "--sampler", String(process.pid), samplePath],
    { stdio: ["ignore", "ignore", "inherit"], windowsHide: true }
  );

  const readSamples = () =>
    fs
      .readFileSync(samplePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

  // Let the sampler pay its cold-start cost before the measured window opens.
  const warmupDeadline = Date.now() + 15_000;
  while (readSamples().length < 5) {
    if (Date.now() > warmupDeadline) throw new Error("Sampler did not start.");
    await new Promise((r) => setTimeout(r, 50));
  }

  const startedAt = new Date();
  const measureFrom = Date.now();
  const WhisperManager = require("../src/helpers/whisper.js");
  const manager = new WhisperManager();
  const result = await manager.transcribeLocalWhisper(audio, {
    model: args.model,
    language: "en",
  });
  const measureTo = Date.now();
  const elapsedMs = measureTo - measureFrom;
  const finishedAt = new Date();

  sampler.kill("SIGTERM");
  await new Promise((r) => sampler.once("exit", r));

  const all = readSamples();
  const window = all.filter((s) => s.at >= measureFrom && s.at <= measureTo);
  const externalHits = window.flatMap((s) => s.external.map((e) => ({ ...e, at: s.at })));
  const loopbackPeers = [...new Set(window.flatMap((s) => s.loopback))];

  // The series is bounded by the window edges, not by the first and last
  // samples. Starting at the first in-window sample would hide a gap at the
  // edge, which is exactly where the interesting one turned out to be.
  const edges = [measureFrom, ...window.map((s) => s.at), measureTo];
  const rawGaps = edges.slice(1).map((t, i) => ({ ms: t - edges[i], at: edges[i] }));
  const widest = rawGaps.reduce((a, b) => (b.ms > (a?.ms ?? -1) ? b : a), null);
  const widestAtMs = widest ? widest.at - measureFrom : 0;
  const gaps = rawGaps.map((g) => g.ms).sort((a, b) => a - b);
  const pct = (p) =>
    gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))] : 0;

  const text = (result?.text || "").trim();
  const pass = externalHits.length === 0 && text.length > 0;

  console.log(`  transcript   ${text.length} chars in ${elapsedMs} ms`);
  console.log(`  samples      ${window.length} in window (${all.length - window.length} outside)`);
  console.log(
    `  sample gap   median ${pct(0.5)} ms, p95 ${pct(0.95)} ms, max ${gaps.at(-1) ?? 0} ms at t+${widestAtMs} ms`
  );
  console.log(`  loopback     ${loopbackPeers.length} established peer(s)`);
  console.log(`  external     ${externalHits.length}`);
  console.log(
    `\n  ${pass ? "PASS" : "FAIL"} - ${pass ? "no external endpoint observed" : "external endpoints observed"}\n`
  );
  for (const hit of externalHits.slice(0, 20)) {
    console.log(`    ${hit.name} (pid ${hit.pid}) -> ${hit.remote} ${hit.state}`);
  }

  fs.unlinkSync(samplePath);

  // Local date, not UTC. A run just after midnight would otherwise be filed
  // under the previous day.
  const stamp = `${startedAt.getFullYear()}-${String(startedAt.getMonth() + 1).padStart(2, "0")}-${String(startedAt.getDate()).padStart(2, "0")}`;
  const outDir = path.resolve(REPO_ROOT, args.out);
  fs.mkdirSync(outDir, { recursive: true });

  const record = {
    verdict: pass ? "pass" : "fail",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    appVersion: require("../package.json").version,
    node: process.version,
    os: `${os.platform()} ${os.release()} ${os.arch()}`,
    model: args.model,
    audio: { path: path.relative(REPO_ROOT, audioPath), bytes: audio.length, sha256: audioSha },
    transcriptChars: text.length,
    transcriptSha256: crypto.createHash("sha256").update(text).digest("hex"),
    elapsedMs,
    sampling: {
      samplesInWindow: window.length,
      medianGapMs: pct(0.5),
      p95GapMs: pct(0.95),
      maxGapMs: gaps.at(-1) ?? 0,
      maxGapAtMs: widestAtMs,
      samplerProcess: "separate",
    },
    loopbackPeers,
    externalHits,
  };
  fs.writeFileSync(
    path.join(outDir, `local-only-${stamp}.json`),
    `${JSON.stringify(record, null, 2)}\n`
  );

  fs.writeFileSync(
    path.join(outDir, `local-only-${stamp}.md`),
    `# Local-only transcription evidence - ${stamp}

Generated by \`scripts/verify-local-only.js\`. Evidence for this machine, this
version and this run only. It is not a universal claim.

**Verdict: ${pass ? "PASS" : "FAIL"}.** ${
      pass
        ? "The transcription process tree held no connection to any address off this machine at any sampled moment, and produced a transcript anyway."
        : "An external endpoint was observed. See below."
    }

## Environment

| | |
|---|---|
| PrivateTranscribe | ${record.appVersion} |
| OS | ${record.os} |
| Node | ${record.node} |
| Model | ${args.model}, local Whisper |
| Started | ${record.startedAt} |

## Input and output

| | |
|---|---|
| Audio | \`${record.audio.path}\`, ${record.audio.bytes} bytes |
| Audio SHA-256 | \`${record.audio.sha256}\` |
| Transcript | ${record.transcriptChars} characters in ${elapsedMs} ms |
| Transcript SHA-256 | \`${record.transcriptSha256}\` |

The non-empty transcript matters as much as the empty connection list. It shows
the run did the work rather than failing early and reporting silence.

## Method

Read a WAV from disk, not the microphone, and never touched the clipboard or the
foreground window. While \`transcribeLocalWhisper\` ran, a **separate process**
sampled the connection table with \`netstat -ano\`, filtered to the process tree
rooted at the transcribing process and refreshed every ${TREE_REFRESH_MS} ms so
\`whisper-server\` was picked up when it spawned. The sampler excludes itself
from that tree.

Sampling from a separate process is load-bearing. An earlier in-process version
was starved for 1.3 seconds while \`whisper-server\` spawned, putting the blind
spot at precisely the moment an upload would happen.

Every remote address the tree held was classified. The 127/8 block, \`::1\` and
the v4-mapped form count as loopback. Wildcard listen addresses are not
destinations. Anything else is external.

## Sampling

| | |
|---|---|
| Samples in window | ${record.sampling.samplesInWindow} |
| Median gap | ${record.sampling.medianGapMs} ms |
| p95 gap | ${record.sampling.p95GapMs} ms |
| Largest gap | ${record.sampling.maxGapMs} ms, at t+${record.sampling.maxGapAtMs} ms |

The series is bounded by the window edges, not by the first and last samples, so
a gap at either edge is counted rather than hidden.

## Connections held by the transcription tree

Loopback peers, established:${
      loopbackPeers.length ? `\n\n${loopbackPeers.map((p) => `- \`${p}\``).join("\n")}` : " none"
    }

External endpoints: **${externalHits.length}**${
      externalHits.length
        ? `\n\n${externalHits
            .slice(0, 50)
            .map((h) => `- \`${h.name}\` (pid ${h.pid}) to \`${h.remote}\` ${h.state}`)
            .join("\n")}`
        : ""
    }

The loopback traffic is expected and is stated rather than hidden. Local
transcription runs \`whisper-server\` as a child process and talks to it over
127.0.0.1. That is two processes on one machine talking to each other; it does
not reach a network.

## What this does not establish

This samples the connection table, it does not intercept packets. A connection
opened and closed entirely within one sampling gap would not appear. The gap
distribution above is published so that hole can be judged rather than assumed.

The conclusive companion test blocks the app outbound at the firewall and
confirms local transcription still completes. That needs an elevated prompt, so
run it by hand:

\`\`\`powershell
# Elevated PowerShell.
New-NetFirewallRule -DisplayName "PT local-only test" -Direction Outbound \`
  -Program "C:\\Program Files\\PrivateTranscribe\\PrivateTranscribe.exe" -Action Block

# Dictate normally with a local Whisper model. It should still work.

Remove-NetFirewallRule -DisplayName "PT local-only test"
\`\`\`

A run that transcribes correctly with outbound blocked is not a sampled
observation. It is a demonstration that the network is not on the path.
`
  );

  console.log(`  wrote docs/goal-evidence/local-only-${stamp}.json`);
  console.log(`  wrote docs/goal-evidence/local-only-${stamp}.md\n`);

  if (typeof manager.cleanup === "function") {
    try {
      await manager.cleanup();
    } catch {
      /* best effort */
    }
  }
  process.exit(pass ? 0 : 1);
}

if (process.argv[2] === "--sampler") {
  runSampler(Number(process.argv[3]), process.argv[4]);
} else {
  main().catch((err) => {
    console.error(`\n${err.stack || err.message}\n`);
    process.exit(1);
  });
}
