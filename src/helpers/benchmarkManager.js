const { randomUUID } = require("crypto");
const debugLogger = require("./debugLogger");

/**
 * BenchmarkManager — measures transcription speed on this device.
 *
 * Generates a known-duration silent WAV sample, sends it through the active
 * transcription engine, and records wall-clock time. The result is expressed
 * as a "real-time factor" (audio seconds / processing seconds), giving the
 * user a truthful, device-specific measure of their local transcription speed.
 *
 * Results are persisted in the `benchmarks` database table so the user can
 * see their most recent measurement across sessions.
 */

// ── Pure helpers (exported for unit testing) ─────────────────────────────

/**
 * Generate a valid 16 kHz mono 16-bit PCM WAV buffer of silence.
 * @param {number} durationSeconds
 * @returns {Buffer}
 */
function generateSilentWav(durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 60) {
    throw new Error("durationSeconds must be between 0 and 60");
  }

  const sampleRate = 16000;
  const bitsPerSample = 16;
  const numChannels = 1;
  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.round(sampleRate * durationSeconds);
  const dataSize = numSamples * numChannels * bytesPerSample;

  // 44-byte WAV header + PCM data (all zeros = silence)
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
  // PCM samples are already zero (silence)

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
  if (!Number.isFinite(factor) || factor <= 0) return "—";
  if (factor >= 100) return `${Math.round(factor)}x real-time`;
  if (factor >= 10) return `${factor.toFixed(1)}x real-time`;
  return `${factor.toFixed(2)}x real-time`;
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

      // 1. Generate test audio
      const audioBuffer = generateSilentWav(BENCHMARK_AUDIO_DURATION_SEC);

      // 2. Detect hardware context
      let detection = null;
      try {
        detection = await this.hardwareDetector.detectHardware();
      } catch {
        // Non-fatal — we can still benchmark without hardware context
      }

      // 3. Run transcription and measure
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
      const record = buildBenchmarkRecord({
        provider: provider || "whisper",
        model: model || (provider === "nvidia" ? "parakeet-tdt-0.6b-v3" : "turbo"),
        gpuCategory: detection?.recommendations?.gpuCategory || "cpu_only",
        audioDurationSec: BENCHMARK_AUDIO_DURATION_SEC,
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
  generateSilentWav,
  computeRealtimeFactor,
  buildBenchmarkRecord,
  formatRealtimeFactor,
  BENCHMARK_AUDIO_DURATION_SEC,
};
