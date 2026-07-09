const path = require("path");
const fs = require("fs");
const { randomUUID } = require("crypto");
const debugLogger = require("./debugLogger");

/**
 * BenchmarkManager - measures transcription speed on this device.
 *
 * Sends a known-duration audio sample through the active transcription engine
 * and records wall-clock time. The result is expressed as a "real-time factor"
 * (audio seconds / processing seconds), giving the user a truthful,
 * device-specific measure of their local transcription speed.
 *
 * Audio source priority:
 *   1. resources/benchmark.wav — drop in any 16 kHz mono WAV for a realistic
 *      speech benchmark. A 10-second LibriSpeech or CC0 clip works well.
 *   2. Synthetic white noise — generated deterministically when no file exists.
 *      Much better than silence (forces the full encoder+decoder pipeline) but
 *      not as representative as real speech for GPU vs CPU comparison.
 *
 * Results are persisted in the `benchmarks` database table so the user can
 * see their most recent measurement across sessions.
 */

/**
 * Candidate paths for a user-supplied benchmark WAV file.
 * Checked in order; first existing file wins.
 */
function findBundledBenchmarkWav() {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "benchmark.wav"));
  }
  candidates.push(path.join(__dirname, "..", "..", "resources", "benchmark.wav"));
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Load benchmark audio: prefers a bundled speech WAV file; falls back to
 * synthetic white noise. Returns { buffer, durationSeconds, source }.
 */
async function loadBenchmarkAudio() {
  const wavPath = findBundledBenchmarkWav();
  if (wavPath) {
    try {
      const buffer = await fs.promises.readFile(wavPath);
      // Scan WAV chunks to find the 'data' chunk (not hardcoded offset — ffmpeg
      // may insert extra chunks like LIST/INFO between fmt and data).
      const byteRate = buffer.readUInt32LE(28);
      let dataSize = 0;
      let scanOffset = 12; // skip RIFF header (4 bytes id + 4 bytes size + 4 bytes WAVE)
      while (scanOffset + 8 <= buffer.length) {
        const chunkId = buffer.toString("ascii", scanOffset, scanOffset + 4);
        const chunkSize = buffer.readUInt32LE(scanOffset + 4);
        if (chunkId === "data") {
          dataSize = chunkSize;
          break;
        }
        scanOffset += 8 + chunkSize;
      }
      const durationSeconds =
        byteRate > 0 && dataSize > 0 ? dataSize / byteRate : BENCHMARK_AUDIO_DURATION_SEC;
      debugLogger.info("BenchmarkManager: using bundled benchmark.wav", {
        path: wavPath,
        durationSeconds,
      });
      return { buffer, durationSeconds, source: "file" };
    } catch (err) {
      debugLogger.warn(
        "BenchmarkManager: failed to read benchmark.wav, falling back to synthetic",
        {
          error: err.message,
        }
      );
    }
  }
  debugLogger.info("BenchmarkManager: using synthetic white-noise audio");
  return {
    buffer: generateBenchmarkAudio(BENCHMARK_AUDIO_DURATION_SEC),
    durationSeconds: BENCHMARK_AUDIO_DURATION_SEC,
    source: "synthetic",
  };
}

// ── Pure helpers (exported for unit testing) ─────────────────────────────

/**
 * Generate a valid 16 kHz mono 16-bit PCM WAV buffer filled with deterministic
 * white noise. Unlike silence, noise forces the full encoder + decoder pipeline
 * in both whisper.cpp and Parakeet, giving accurate and comparable timings.
 * Pure silence allows both engines to fast-path via energy/VAD checks, making
 * CPU and GPU results look identical — which is misleading.
 *
 * The noise is generated with a seeded LCG so the same audio is produced on
 * every run, keeping benchmark results reproducible and comparable over time.
 *
 * @param {number} durationSeconds
 * @returns {Buffer}
 */
function generateBenchmarkAudio(durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 60) {
    throw new Error("durationSeconds must be between 0 and 60");
  }

  const sampleRate = 16000;
  const bitsPerSample = 16;
  const numChannels = 1;
  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.round(sampleRate * durationSeconds);
  const dataSize = numSamples * numChannels * bytesPerSample;

  // 44-byte WAV header + PCM data
  const buffer = Buffer.alloc(44 + dataSize, 0);

  // RIFF header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);

  // fmt sub-chunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // sub-chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28); // byte rate
  buffer.writeUInt16LE(numChannels * bytesPerSample, 32); // block align
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data sub-chunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Fill with deterministic white noise (seeded LCG) at ~15 % amplitude.
  // Low enough to avoid clipping, high enough to defeat VAD silence detection.
  const maxSample = Math.round(0.15 * 32767);
  let seed = 0x12345678;
  for (let i = 0; i < numSamples; i++) {
    // Linear Congruential Generator (Numerical Recipes constants)
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    // Map unsigned 32-bit value to signed 16-bit range
    const sample = Math.round(((seed >>> 1) / 0x40000000 - 1) * maxSample);
    buffer.writeInt16LE(sample, 44 + i * bytesPerSample);
  }

  return buffer;
}

/**
 * Compute the real-time factor from a benchmark measurement.
 * @param {number} audioDurationSec - duration of the audio sample in seconds
 * @param {number} elapsedMs - wall-clock processing time in milliseconds
 * @returns {number} real-time factor (higher = faster)
 */
function computeRealtimeFactor(audioDurationSec, elapsedMs) {
  if (elapsedMs <= 0) return 0;
  return audioDurationSec / (elapsedMs / 1000);
}

/**
 * Build a benchmark result record from raw measurement data.
 * @param {object} params
 * @returns {object}
 */
function buildBenchmarkRecord({
  provider,
  model,
  gpuCategory,
  audioDurationSec,
  elapsedMs,
  gpuModel,
  cpuModel,
  cpuCores,
}) {
  return {
    id: randomUUID(),
    provider: provider || "unknown",
    model: model || "unknown",
    gpuCategory: gpuCategory || "cpu_only",
    audioDurationSec,
    elapsedMs: Math.round(elapsedMs),
    realtimeFactor: Math.round(computeRealtimeFactor(audioDurationSec, elapsedMs) * 100) / 100,
    gpuModel: gpuModel || null,
    cpuModel: cpuModel || null,
    cpuCores: cpuCores || null,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Format a real-time factor for display (e.g., "12.3x real-time").
 * @param {number} factor
 * @returns {string}
 */
function formatRealtimeFactor(factor) {
  if (!Number.isFinite(factor) || factor <= 0) return "-";
  if (factor >= 100) return `${Math.round(factor)}x real-time`;
  if (factor >= 10) return `${factor.toFixed(1)}x real-time`;
  return `${factor.toFixed(2)}x real-time`;
}

/**
 * Compute the speedup ratio between two real-time factors.
 * Returns how many times faster the GPU result is compared to the CPU result.
 * @param {number} cpuRealtimeFactor
 * @param {number} gpuRealtimeFactor
 * @returns {number} speedup (e.g. 5.2 means GPU is 5.2x faster)
 */
function computeSpeedup(cpuRealtimeFactor, gpuRealtimeFactor) {
  if (
    !Number.isFinite(cpuRealtimeFactor) ||
    !Number.isFinite(gpuRealtimeFactor) ||
    cpuRealtimeFactor <= 0
  ) {
    return 0;
  }
  return Math.round((gpuRealtimeFactor / cpuRealtimeFactor) * 100) / 100;
}

/**
 * Build a comparison benchmark record from a CPU result and a GPU result.
 * @param {object} params
 * @param {object} params.cpuResult - benchmark record from CPU (whisper) run
 * @param {object} params.gpuResult - benchmark record from GPU (nvidia) run
 * @returns {object}
 */
function buildComparisonRecord({ cpuResult, gpuResult }) {
  return {
    id: randomUUID(),
    cpuResult,
    gpuResult,
    speedup: computeSpeedup(cpuResult.realtimeFactor, gpuResult.realtimeFactor),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Format a speedup ratio for display (e.g., "5.2x faster").
 * @param {number} speedup
 * @returns {string}
 */
function formatSpeedup(speedup) {
  if (!Number.isFinite(speedup) || speedup <= 0) return "-";
  if (speedup < 1.05) return "about the same speed";
  if (speedup >= 100) return `${Math.round(speedup)}x faster`;
  if (speedup >= 10) return `${speedup.toFixed(1)}x faster`;
  return `${speedup.toFixed(2)}x faster`;
}

// ── BenchmarkManager class ───────────────────────────────────────────────

const BENCHMARK_AUDIO_DURATION_SEC = 10;

class BenchmarkManager {
  /**
   * @param {object} databaseManager - DatabaseManager instance (has .db property)
   * @param {object} whisperManager - WhisperManager instance
   * @param {object} parakeetManager - ParakeetManager instance
   * @param {object} hardwareDetector - HardwareDetector instance
   */
  constructor(databaseManager, whisperManager, parakeetManager, hardwareDetector) {
    this.databaseManager = databaseManager;
    this.whisperManager = whisperManager;
    this.parakeetManager = parakeetManager;
    this.hardwareDetector = hardwareDetector;
    this._running = false;

    this._ensureTable();
    this._ensureComparisonTable();
  }

  _ensureTable() {
    try {
      this.databaseManager.db.exec(`
        CREATE TABLE IF NOT EXISTS benchmarks (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          gpu_category TEXT NOT NULL,
          audio_duration_sec REAL NOT NULL,
          elapsed_ms INTEGER NOT NULL,
          realtime_factor REAL NOT NULL,
          gpu_model TEXT,
          cpu_model TEXT,
          cpu_cores INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
    } catch (err) {
      debugLogger.warn("Failed to create benchmarks table", { error: err.message });
    }
  }

  _ensureComparisonTable() {
    try {
      this.databaseManager.db.exec(`
        CREATE TABLE IF NOT EXISTS benchmark_comparisons (
          id TEXT PRIMARY KEY,
          cpu_benchmark_id TEXT NOT NULL,
          gpu_benchmark_id TEXT NOT NULL,
          speedup REAL NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (cpu_benchmark_id) REFERENCES benchmarks(id),
          FOREIGN KEY (gpu_benchmark_id) REFERENCES benchmarks(id)
        )
      `);
    } catch (err) {
      debugLogger.warn("Failed to create benchmark_comparisons table", { error: err.message });
    }
  }

  /**
   * Run a transcription speed test using the specified provider.
   * @param {object} options
   * @param {"whisper"|"nvidia"} options.provider - which engine to benchmark
   * @param {string} [options.model] - model name (e.g., "turbo", "parakeet-tdt-0.6b-v3")
   * @returns {Promise<object>} benchmark result record
   */
  async run({ provider, model } = {}) {
    if (this._running) {
      throw new Error("A benchmark is already running");
    }
    this._running = true;

    try {
      debugLogger.info("Benchmark starting", { provider, model });

      // 1. Load test audio (bundled speech WAV preferred, synthetic noise fallback)
      const {
        buffer: audioBuffer,
        durationSeconds: audioDurationSec,
        source: audioSource,
      } = await loadBenchmarkAudio();
      debugLogger.info("Benchmark audio loaded", { source: audioSource, audioDurationSec });

      // 2. Detect hardware context
      let detection = null;
      try {
        detection = await this.hardwareDetector.detectHardware();
      } catch {
        // Non-fatal - we can still benchmark without hardware context
      }

      // 3. Warmup run — loads model into GPU/CPU cache; result discarded.
      // Without this, first-run benchmarks are 10-20x slower due to VRAM cold-start.
      debugLogger.info("Benchmark warmup run (discarded)", { provider, model });
      try {
        if (provider === "nvidia") {
          await this.parakeetManager.transcribeLocalParakeet(audioBuffer, {
            model: model || "parakeet-tdt-0.6b-v3",
          });
        } else {
          await this.whisperManager.transcribeLocalWhisper(audioBuffer, {
            model: model || "turbo",
            inputFileName: "benchmark.wav",
          });
        }
      } catch {
        // Warmup failure is non-fatal — proceed to timed run anyway
      }

      // 4. Timed run — model is now warm
      const startTime = Date.now();

      if (provider === "nvidia") {
        await this.parakeetManager.transcribeLocalParakeet(audioBuffer, {
          model: model || "parakeet-tdt-0.6b-v3",
        });
      } else {
        // Default to whisper
        await this.whisperManager.transcribeLocalWhisper(audioBuffer, {
          model: model || "turbo",
          inputFileName: "benchmark.wav",
        });
      }

      const elapsedMs = Date.now() - startTime;

      // 4. Build result record
      // For whisper, check if forceCpu is active — if so, label as cpu_only
      // even when the hardware has CUDA, since the CPU binary was actually used.
      let effectiveGpuCategory = detection?.recommendations?.gpuCategory || "cpu_only";
      if (provider !== "nvidia") {
        try {
          const cudaStatus = this.whisperManager.getCudaBinaryStatus?.();
          if (cudaStatus?.installed && cudaStatus?.forceCpu) {
            effectiveGpuCategory = "cpu_only";
          }
        } catch {
          // Non-fatal — fall back to hardware-detected category
        }
      }

      const record = buildBenchmarkRecord({
        provider: provider || "whisper",
        model: model || (provider === "nvidia" ? "parakeet-tdt-0.6b-v3" : "turbo"),
        gpuCategory: effectiveGpuCategory,
        audioDurationSec,
        elapsedMs,
        gpuModel: detection?.gpu?.model || null,
        cpuModel: detection?.cpu?.model || null,
        cpuCores: detection?.cpu?.count || null,
      });

      // 5. Persist
      this._saveResult(record);

      debugLogger.info("Benchmark completed", {
        provider: record.provider,
        model: record.model,
        elapsedMs: record.elapsedMs,
        realtimeFactor: record.realtimeFactor,
      });

      return record;
    } finally {
      this._running = false;
    }
  }

  _saveResult(record) {
    try {
      const stmt = this.databaseManager.db.prepare(`
        INSERT INTO benchmarks (id, provider, model, gpu_category, audio_duration_sec, elapsed_ms, realtime_factor, gpu_model, cpu_model, cpu_cores, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        record.id,
        record.provider,
        record.model,
        record.gpuCategory,
        record.audioDurationSec,
        record.elapsedMs,
        record.realtimeFactor,
        record.gpuModel,
        record.cpuModel,
        record.cpuCores,
        record.createdAt
      );
    } catch (err) {
      debugLogger.warn("Failed to save benchmark result", { error: err.message });
    }
  }

  /**
   * Get the most recent benchmark result, optionally filtered by provider.
   * @param {string} [provider] - "whisper" or "nvidia"
   * @returns {object|null}
   */
  getLatest(provider) {
    try {
      let row;
      if (provider) {
        row = this.databaseManager.db
          .prepare("SELECT * FROM benchmarks WHERE provider = ? ORDER BY created_at DESC LIMIT 1")
          .get(provider);
      } else {
        row = this.databaseManager.db
          .prepare("SELECT * FROM benchmarks ORDER BY created_at DESC LIMIT 1")
          .get();
      }
      return row ? this._rowToRecord(row) : null;
    } catch (err) {
      debugLogger.warn("Failed to get benchmark result", { error: err.message });
      return null;
    }
  }

  /**
   * Get all benchmark results, most recent first.
   * @param {number} [limit=10]
   * @returns {object[]}
   */
  getAll(limit = 10) {
    try {
      const rows = this.databaseManager.db
        .prepare("SELECT * FROM benchmarks ORDER BY created_at DESC LIMIT ?")
        .all(limit);
      return rows.map((r) => this._rowToRecord(r));
    } catch (err) {
      debugLogger.warn("Failed to get benchmark results", { error: err.message });
      return [];
    }
  }

  /**
   * Run a CPU vs GPU comparison benchmark.
   * Runs whisper (CPU) and parakeet (GPU) sequentially on the same audio,
   * then stores the individual results and the comparison.
   * @param {object} [options]
   * @param {string} [options.cpuModel] - whisper model (default: "turbo")
   * @param {string} [options.gpuModel] - parakeet model (default: "parakeet-tdt-0.6b-v3")
   * @returns {Promise<object>} comparison record with cpuResult, gpuResult, speedup
   */
  async runComparison({ cpuModel, gpuModel } = {}) {
    if (this._running) {
      throw new Error("A benchmark is already running");
    }
    this._running = true;
    const previousWhisperForceCpu = this.whisperManager.serverManager?.forceCpu;

    try {
      // Force CPU mode for the Whisper benchmark leg — the user's normal
      // preference (which may be GPU) is restored in finally.
      try {
        await this.whisperManager.setForceCpu(true);
      } catch {
        // Non-fatal: proceed with whatever engine is active
      }
      debugLogger.info("Comparison benchmark starting", { cpuModel, gpuModel });

      // Load test audio — same sample used for both engines so the comparison is fair
      const {
        buffer: audioBuffer,
        durationSeconds: audioDurationSec,
        source: audioSource,
      } = await loadBenchmarkAudio();
      debugLogger.info("Comparison benchmark audio loaded", {
        source: audioSource,
        audioDurationSec,
      });

      // Detect hardware once
      let detection = null;
      try {
        detection = await this.hardwareDetector.detectHardware();
      } catch {
        // Non-fatal
      }

      const hwContext = {
        gpuCategory: detection?.recommendations?.gpuCategory || "cpu_only",
        gpuModelName: detection?.gpu?.model || null,
        cpuModelName: detection?.cpu?.model || null,
        cpuCores: detection?.cpu?.count || null,
      };

      const cpuModelName = cpuModel || "turbo";
      const gpuModelName = gpuModel || "parakeet-tdt-0.6b-v3";

      // ── Warmup runs (discarded) ───────────────────────────────────────────
      // Ensures both servers are running and models are loaded into cache
      // before timing. Without this, cold-start server startup time (which
      // can be several seconds) is included in the timed run, making the
      // results inaccurate and non-comparable.
      debugLogger.info("Comparison benchmark: warmup runs (discarded)", {
        cpuModel: cpuModelName,
        gpuModel: gpuModelName,
      });
      try {
        await this.whisperManager.transcribeLocalWhisper(audioBuffer, {
          model: cpuModelName,
          inputFileName: "benchmark.wav",
        });
      } catch {
        // Warmup failure is non-fatal — proceed to timed run
      }
      try {
        await this.parakeetManager.transcribeLocalParakeet(audioBuffer, {
          model: gpuModelName,
        });
      } catch {
        // Warmup failure is non-fatal — proceed to timed run
      }

      // ── Run CPU (Whisper) benchmark ──
      // This comparison leg is explicitly CPU-only, regardless of the user's
      // normal Whisper engine preference. The previous preference is restored
      // in finally so benchmarks do not leave the app in the wrong mode.
      const whisperGpuCategory = "cpu_only";

      const cpuStart = Date.now();
      await this.whisperManager.transcribeLocalWhisper(audioBuffer, {
        model: cpuModelName,
        inputFileName: "benchmark.wav",
      });
      const cpuElapsed = Date.now() - cpuStart;

      const cpuRecord = buildBenchmarkRecord({
        provider: "whisper",
        model: cpuModelName,
        gpuCategory: whisperGpuCategory,
        audioDurationSec,
        elapsedMs: cpuElapsed,
        gpuModel: hwContext.gpuModelName,
        cpuModel: hwContext.cpuModelName,
        cpuCores: hwContext.cpuCores,
      });
      this._saveResult(cpuRecord);

      // ── Run GPU (Parakeet) benchmark ──
      const gpuStart = Date.now();
      await this.parakeetManager.transcribeLocalParakeet(audioBuffer, {
        model: gpuModelName,
      });
      const gpuElapsed = Date.now() - gpuStart;

      const gpuRecord = buildBenchmarkRecord({
        provider: "nvidia",
        model: gpuModelName,
        gpuCategory: hwContext.gpuCategory,
        audioDurationSec,
        elapsedMs: gpuElapsed,
        gpuModel: hwContext.gpuModelName,
        cpuModel: hwContext.cpuModelName,
        cpuCores: hwContext.cpuCores,
      });
      this._saveResult(gpuRecord);

      // ── Build and persist comparison ──
      const comparison = buildComparisonRecord({
        cpuResult: cpuRecord,
        gpuResult: gpuRecord,
      });
      this._saveComparison(comparison);

      debugLogger.info("Comparison benchmark completed", {
        cpuRealtimeFactor: cpuRecord.realtimeFactor,
        gpuRealtimeFactor: gpuRecord.realtimeFactor,
        speedup: comparison.speedup,
      });

      return comparison;
    } finally {
      if (typeof previousWhisperForceCpu === "boolean") {
        try {
          await this.whisperManager.setForceCpu(previousWhisperForceCpu);
        } catch (err) {
          debugLogger.warn("Failed to restore Whisper CPU/GPU preference after benchmark", {
            error: err.message,
            previousWhisperForceCpu,
          });
        }
      }
      this._running = false;
    }
  }

  _saveComparison(comparison) {
    try {
      const stmt = this.databaseManager.db.prepare(`
        INSERT INTO benchmark_comparisons (id, cpu_benchmark_id, gpu_benchmark_id, speedup, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      stmt.run(
        comparison.id,
        comparison.cpuResult.id,
        comparison.gpuResult.id,
        comparison.speedup,
        comparison.createdAt
      );
    } catch (err) {
      debugLogger.warn("Failed to save comparison result", { error: err.message });
    }
  }

  /**
   * Get the most recent comparison benchmark result.
   * Joins with the individual benchmark records to return full context.
   * @returns {object|null}
   */
  getLatestComparison() {
    try {
      const row = this.databaseManager.db
        .prepare(
          `SELECT c.id, c.cpu_benchmark_id, c.gpu_benchmark_id, c.speedup, c.created_at
           FROM benchmark_comparisons c
           ORDER BY c.created_at DESC LIMIT 1`
        )
        .get();

      if (!row) return null;

      const cpuRow = this.databaseManager.db
        .prepare("SELECT * FROM benchmarks WHERE id = ?")
        .get(row.cpu_benchmark_id);
      const gpuRow = this.databaseManager.db
        .prepare("SELECT * FROM benchmarks WHERE id = ?")
        .get(row.gpu_benchmark_id);

      if (!cpuRow || !gpuRow) return null;

      return {
        id: row.id,
        cpuResult: this._rowToRecord(cpuRow),
        gpuResult: this._rowToRecord(gpuRow),
        speedup: row.speedup,
        createdAt: row.created_at,
      };
    } catch (err) {
      debugLogger.warn("Failed to get comparison result", { error: err.message });
      return null;
    }
  }

  /** @returns {boolean} */
  isRunning() {
    return this._running;
  }

  _rowToRecord(row) {
    return {
      id: row.id,
      provider: row.provider,
      model: row.model,
      gpuCategory: row.gpu_category,
      audioDurationSec: row.audio_duration_sec,
      elapsedMs: row.elapsed_ms,
      realtimeFactor: row.realtime_factor,
      gpuModel: row.gpu_model,
      cpuModel: row.cpu_model,
      cpuCores: row.cpu_cores,
      createdAt: row.created_at,
    };
  }
}

module.exports = {
  BenchmarkManager,
  // Pure helpers exported for testing
  generateBenchmarkAudio,
  computeRealtimeFactor,
  buildBenchmarkRecord,
  formatRealtimeFactor,
  computeSpeedup,
  buildComparisonRecord,
  formatSpeedup,
  BENCHMARK_AUDIO_DURATION_SEC,
};
