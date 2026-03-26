#!/usr/bin/env node
"use strict";

/**
 * Transcription pipeline benchmark — times each stage of whisper.cpp inference.
 * Usage: node scripts/benchmark-transcription.js [--clips ./test-clips] [--runs 3] [--model turbo]
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const net = require("net");
const { spawn } = require("child_process");

// ─── CLI ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`
  node scripts/benchmark-transcription.js [options]

  Options:
    --clips <dir>   Folder of audio clips to benchmark (default: ./test-clips)
    --runs  <n>     Number of runs per clip (default: 3)
    --model <name>  Whisper model name: tiny/base/small/medium/large/turbo (default: turbo)
    --help          Show this message
  `);
  process.exit(0);
}

function getArg(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

const rawClipsDir = getArg("--clips");
const CLIPS_DIR = rawClipsDir ||
  (fs.existsSync("./tests/test-clips") ? "./tests/test-clips" : "./test-clips");
const RUNS = Math.max(1, parseInt(getArg("--runs") || "3", 10));
const MODEL_NAME = getArg("--model") || "turbo";
const SUPPORTED_EXTS = new Set([".wav", ".mp3", ".m4a", ".webm"]);

// ─── Locate binary & model ────────────────────────────────────────────────────

/**
 * Locate FFmpeg: try ffmpeg-static (bundled), then known system paths, then PATH.
 * Mirrors the logic in src/helpers/ffmpegUtils.js so Windows works without PATH setup.
 */
function findFFmpegPath() {
  // 1. Try bundled ffmpeg-static (works in dev; production uses ASAR-unpacked copy)
  try {
    let ffmpegPath = require("ffmpeg-static");
    ffmpegPath = require("path").normalize(ffmpegPath);
    if (process.platform === "win32" && !ffmpegPath.endsWith(".exe")) ffmpegPath += ".exe";

    // Production ASAR-unpacked path takes precedence
    const unpackedPath = ffmpegPath.includes("app.asar")
      ? ffmpegPath.replace(/app\.asar([/\\])/, "app.asar.unpacked$1")
      : null;
    if (unpackedPath && fs.existsSync(unpackedPath)) return unpackedPath;
    if (fs.existsSync(ffmpegPath)) return ffmpegPath;
  } catch { /* ffmpeg-static not installed */ }

  // 2. Well-known system locations
  const systemCandidates =
    process.platform === "darwin"
      ? ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]
      : process.platform === "win32"
        ? ["C:\\ffmpeg\\bin\\ffmpeg.exe"]
        : ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
  for (const c of systemCandidates) if (fs.existsSync(c)) return c;

  // 3. Search PATH
  const pathBinary = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  for (const dir of (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    const c = path.join(dir.replace(/^"|"$/g, ""), pathBinary);
    if (fs.existsSync(c)) return c;
  }

  return null;
}

function findWhisperBinary() {
  const platform = process.platform;
  const arch = process.arch;
  const ext = platform === "win32" ? ".exe" : "";
  const names = [
    `whisper-server-${platform}-${arch}${ext}`,
    `whisper-server${ext}`,
  ];
  const roots = [
    path.join(__dirname, "..", "resources", "bin"),
    path.join(process.cwd(), "resources", "bin"),
  ];
  for (const root of roots) {
    for (const name of names) {
      const p = path.join(root, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function findModelPath(modelName, dirs) {
  const home = os.homedir();
  dirs = dirs || [
    path.join(home, ".cache", "PrivateTranscribe", "whisper-models"),
    path.join(home, ".cache", "Privoca", "whisper-models"),
  ];
  // Try several naming conventions whisper.cpp uses
  const candidates = [
    `ggml-${modelName}.bin`,
    `ggml-large-v3-${modelName}.bin`,
    `ggml-large-v3-turbo.bin`,
    `ggml-${modelName}-q5_0.bin`,
  ];
  for (const dir of dirs) {
    for (const name of candidates) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
    // Also scan the dir for any .bin file matching the model name loosely
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith(".bin"));
      const match = files.find(f => f.toLowerCase().includes(modelName.toLowerCase()));
      if (match) return path.join(dir, match);
      // Last resort: return the only .bin if there's just one
      if (files.length === 1) return path.join(dir, files[0]);
    } catch { /* dir doesn't exist */ }
  }
  return null;
}

// ─── Synthetic clip (silent 16kHz WAV) ───────────────────────────────────────

function generateSilentWav(durationSec = 5) {
  const sampleRate = 16000;
  const numSamples = sampleRate * durationSec;
  const dataSize = numSamples * 2; // 16-bit PCM
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);                        buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);                        buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);                   buf.writeUInt16LE(1, 20);   // PCM
  buf.writeUInt16LE(1, 22);                    buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);       buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);                   buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

function isPortFree(port) {
  return new Promise((res) => {
    const s = net.createServer();
    s.once("error", () => res(false));
    s.once("listening", () => { s.close(); res(true); });
    s.listen(port, "127.0.0.1");
  });
}

async function findPort(start = 8178, end = 8199) {
  for (let p = start; p <= end; p++) if (await isPortFree(p)) return p;
  throw new Error("No free port in range 8178-8199");
}

async function startServer(binary, modelPath) {
  const port = await findPort();
  const args = [
    "--model", modelPath,
    "--host", "127.0.0.1",
    "--port", String(port),
    "--entropy-thold", "2.0",
    "--suppress-nst",
  ];
  const proc = spawn(binary, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    cwd: path.dirname(binary),
  });
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", () => {});

  // Wait up to 30s for server to become reachable
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await checkHealth(port)) return { proc, port };
    await sleep(150);
  }
  proc.kill();
  throw new Error("whisper-server failed to start within 30s");
}

function stopServer(proc) {
  return new Promise((res) => {
    proc.once("close", res);
    proc.kill("SIGTERM");
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 3000);
  });
}

function checkHealth(port) {
  return new Promise((res) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: "/", method: "GET", timeout: 1500 },
      (r) => { res(true); r.resume(); });
    req.on("error", () => res(false));
    req.on("timeout", () => { req.destroy(); res(false); });
    req.end();
  });
}

// ─── Transcribe via HTTP (with timing) ───────────────────────────────────────

/**
 * Convert audio file to 16kHz mono WAV using FFmpeg (matches what the real app does).
 * Returns a Buffer of WAV data, or null if FFmpeg is unavailable.
 */
function convertToWav(inputPath) {
  return new Promise((resolve) => {
    const ffmpegBin = findFFmpegPath();
    if (!ffmpegBin) return resolve(null);
    const outPath = path.join(os.tmpdir(), `bench_${Date.now()}.wav`);
    const proc = spawn(ffmpegBin, [
      "-y", "-i", inputPath,
      "-ar", "16000", "-ac", "1", "-f", "wav", outPath,
    ], { stdio: "ignore" });
    proc.on("close", (code) => {
      if (code === 0 && fs.existsSync(outPath)) {
        const buf = fs.readFileSync(outPath);
        try { fs.unlinkSync(outPath); } catch { /* ignore */ }
        resolve(buf);
      } else {
        resolve(null);
      }
    });
    proc.on("error", () => resolve(null));
  });
}

async function transcribe(audioBuffer, port, inputFileName = "audio.wav") {
  const boundary = `----WB${Date.now()}`;
  const parts = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    audioBuffer,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n--${boundary}--\r\n`),
  ];
  const body = Buffer.concat(parts);

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1", port, path: "/inference", method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length },
      timeout: 300000,
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

// ─── Post-processing (mirrored from src/helpers/whisper.js) ──────────────────

function normalizeWhitespace(text) {
  return text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
}

function removeRepetitions(text) {
  if (!text) return text;
  let cleaned = text;
  for (let n = 30; n >= 3; n--) {
    const re = new RegExp(`((?:\\S+\\s+){${n - 1}}\\S+)(?:\\s+\\1){2,}`, "gi");
    cleaned = cleaned.replace(re, "$1");
  }
  cleaned = cleaned.replace(/\b(\w+)(?:\s+\1){4,}\b/gi, "$1");
  return cleaned.replace(/\s+/g, " ").trim();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (n) => `${n}ms`.padStart(7);

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Resolve clips
  const clipsDir = path.resolve(CLIPS_DIR);
  let clips = [];
  if (fs.existsSync(clipsDir)) {
    clips = fs.readdirSync(clipsDir)
      .filter((f) => SUPPORTED_EXTS.has(path.extname(f).toLowerCase()))
      .map((f) => path.join(clipsDir, f));
  }

  if (clips.length === 0) {
    const synth = path.join(os.tmpdir(), "pt-bench-silent.wav");
    console.log(`No clips in ${clipsDir} — using synthetic 5s silent WAV: ${synth}`);
    if (process.platform === "win32") {
      console.log("  Tip: record some .wav files and place them in ./test-clips/ for real results.");
    }
    fs.writeFileSync(synth, generateSilentWav(5));
    clips = [synth];
  }

  const binary = findWhisperBinary();
  if (!binary) {
    console.error("ERROR: whisper-server binary not found in resources/bin/");
    console.error("  Run:  npm run download:whisper-cpp");
    process.exit(1);
  }

  const modelPath = findModelPath(MODEL_NAME);
  if (!modelPath) {
    console.error(`ERROR: Model "${MODEL_NAME}" not found in ~/.cache/PrivateTranscribe/whisper-models/`);
    console.error("  Download it from the app Settings, or try --model base");
    process.exit(1);
  }

  console.log(`\nBenchmark: model=${MODEL_NAME}  runs=${RUNS}  clips=${clips.length}`);
  console.log(`Binary:    ${binary}`);
  console.log(`Model:     ${modelPath}\n`);

  process.stdout.write("Starting whisper-server… ");
  const t0 = Date.now();
  const { proc, port } = await startServer(binary, modelPath);
  console.log(`ready in ${Date.now() - t0}ms (port ${port})\n`);

  const results = [];

  for (const clipPath of clips) {
    const name = path.basename(clipPath).slice(0, 22).padEnd(22);
    const runData = { audioLoad: [], whisper: [], postProc: [], total: [], changedByPostProc: false, lastText: "" };

    for (let r = 0; r < RUNS; r++) {
      const wallStart = Date.now();

      try {
        // Stage 1: Audio load + FFmpeg conversion to WAV
        const t1 = Date.now();
        const rawBuffer = fs.readFileSync(clipPath);
        const ext = path.extname(clipPath).toLowerCase();
        let audioBuffer;
        if (ext === ".wav") {
          audioBuffer = rawBuffer;
        } else {
          audioBuffer = await convertToWav(clipPath);
          if (!audioBuffer) {
            console.error(`  SKIP: FFmpeg conversion failed for ${name} — is FFmpeg installed?`);
            continue;
          }
        }
        const audioLoadMs = Date.now() - t1;

        // Stage 3: Whisper inference (server does FFmpeg conversion internally)
        const t3 = Date.now();
        const raw = await transcribe(audioBuffer, port, path.basename(clipPath));
        const whisperMs = Date.now() - t3;

        // Stage 4: Post-processing
        const rawText = raw.text || "";
        const t4 = Date.now();
        const processed = removeRepetitions(normalizeWhitespace(rawText));
        const postProcMs = Date.now() - t4;

        const totalMs = Date.now() - wallStart;
        if (processed !== normalizeWhitespace(rawText)) runData.changedByPostProc = true;
        // Keep last run's transcript; note empty results explicitly
        runData.lastText = processed || "[no speech detected]";

        runData.audioLoad.push(audioLoadMs);
        runData.whisper.push(whisperMs);
        runData.postProc.push(postProcMs);
        runData.total.push(totalMs);
      } catch (err) {
        console.error(`  ERROR run ${r + 1}/${RUNS} for ${name.trim()}: ${err.message}`);
      }
    }

    if (runData.total.length === 0) {
      console.error(`  SKIP: all ${RUNS} runs failed for ${name.trim()}`);
      continue;
    }
    const avg = (arr) => Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
    results.push({ name, ...runData, avgAudioLoad: avg(runData.audioLoad), avgWhisper: avg(runData.whisper), avgPostProc: avg(runData.postProc), avgTotal: avg(runData.total) });
    console.log(`  ✓ ${name.trim()}`);
  }

  await stopServer(proc);

  // ── Table ────────────────────────────────────────────────────────────────────
  const W = 24, C1 = 11, C2 = 9, C3 = 9, C4 = 9;
  const hr = "-".repeat(W) + "+" + "-".repeat(C1) + "+" + "-".repeat(C2) + "+" + "-".repeat(C3) + "+" + "-".repeat(C4);
  console.log(`\n${"Clip".padEnd(W)}| ${"FFmpeg+Load".padEnd(C1-1)}| ${"Whisper".padEnd(C2-1)}| ${"Post-proc".padEnd(C3-1)}| ${"Total".padEnd(C4-1)}`);
  console.log(hr);

  let slowest = results[0], sumAL = 0, sumW = 0, sumPP = 0, sumT = 0;
  for (const r of results) {
    const rep = r.changedByPostProc ? " *" : "";
    console.log(`${r.name.padEnd(W)}| ${ms(r.avgAudioLoad).padEnd(C1-1)}| ${ms(r.avgWhisper).padEnd(C2-1)}| ${ms(r.avgPostProc).padEnd(C3-1)}| ${ms(r.avgTotal)}${rep}`);
    sumAL += r.avgAudioLoad; sumW += r.avgWhisper; sumPP += r.avgPostProc; sumT += r.avgTotal;
    if (r.avgTotal > slowest.avgTotal) slowest = r;
  }

  console.log(hr);
  const n = results.length;
  console.log(`${"Average".padEnd(W)}| ${ms(Math.round(sumAL/n)).padEnd(C1-1)}| ${ms(Math.round(sumW/n)).padEnd(C2-1)}| ${ms(Math.round(sumPP/n)).padEnd(C3-1)}| ${ms(Math.round(sumT/n))}`);

  console.log(`\nSlowest clip: ${slowest.name.trim()} (${slowest.avgTotal}ms avg)`);
  console.log("VAD: N/A — whisper.cpp has no separate VAD stage\n");
  if (results.some((r) => r.changedByPostProc)) console.log("* Post-processing removed repetition artifacts\n");

  console.log("\n── Transcriptions ──────────────────────────────────────────────");
  for (const r of results) {
    const tag = r.changedByPostProc ? " [repetition removed]" : "";
    console.log(`\n${r.name}${tag}`);
    console.log(`  "${r.lastText || "(empty)"}"`);
  }
}

if (require.main === module) {
  main().catch((err) => { console.error("Fatal:", err.message); process.exit(1); });
}

// Export pure functions for unit testing
module.exports = { removeRepetitions, normalizeWhitespace, findModelPath, generateSilentWav, findFFmpegPath };
