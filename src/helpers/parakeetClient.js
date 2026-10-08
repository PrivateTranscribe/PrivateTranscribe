"use strict";

/**
 * Parakeet engine client — the main-process face of parakeetHost.js, which runs
 * parakeet-tdt-0.6b-v3 (int8, sherpa-onnx-node) in one long-lived utility
 * process. The engine has no network port; requests travel over the process's
 * message channel.
 *
 * Lifecycle mirrors local Whisper: start() loads the model (called by the
 * record-start pre-warm), an idle timer unloads it after 30 minutes without use,
 * and stop() runs on quit and before an update installs. A crashed child fails
 * the request it was serving and is respawned by the next one.
 *
 * Normal process priority on purpose: dictation is interactive, so the decode
 * should win the CPU rather than wait for it.
 */

const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const { getPhysicalCoreCount } = require("./cpuThreads");
const { removeFillerWords } = require("./fillerWords");

const DEFAULT_MODEL = "parakeet-tdt-0.6b-v3";
const REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_TIMEOUT_MINUTES = 30;
const SPEED_TEST_THRESHOLD_MS = 1500;
// Measured: more threads than physical cores ran 3x slower, and past 4 nothing improved.
const MAX_THREADS = 4;
const REQUIRED_MODEL_FILES = [
  "encoder.int8.onnx",
  "decoder.int8.onnx",
  "joiner.int8.onnx",
  "tokens.txt",
];

function typedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function resolveParakeetThreads(physicalCores = getPhysicalCoreCount()) {
  const cores = Math.floor(Number(physicalCores));
  if (!Number.isFinite(cores) || cores < 1) return 1;
  return Math.min(cores, MAX_THREADS);
}

function isModelDirComplete(modelDir) {
  if (!modelDir || !fs.existsSync(modelDir)) return false;
  return REQUIRED_MODEL_FILES.every((file) => fs.existsSync(path.join(modelDir, file)));
}

function resolveBenchmarkWavPath(resourcesPath = process.resourcesPath) {
  const candidates = [
    ...(resourcesPath ? [path.join(resourcesPath, "benchmark.wav")] : []),
    path.join(__dirname, "..", "..", "resources", "benchmark.wav"),
  ];
  return candidates.find((file) => fs.existsSync(file)) || null;
}

async function readBenchmarkSamples(wavPath) {
  const { parseWavPcmInfo, pcm16ToFloat32 } = require("./wavPcm");
  const buffer = await fs.promises.readFile(wavPath);
  const info = parseWavPcmInfo(buffer);
  if (!info || info.audioFormat !== 1 || info.bitsPerSample !== 16 || info.channels !== 1) {
    throw typedError("benchmark-unreadable", "benchmark.wav is not 16-bit mono PCM");
  }
  const pcm = buffer.subarray(info.dataOffset, info.dataOffset + info.dataSize);
  return { samples: pcm16ToFloat32(pcm), sampleRate: info.sampleRate };
}

function createHostProcess() {
  const hostPath = path.join(__dirname, "parakeetHost.js");
  if (process.versions.electron) {
    return require("electron").utilityProcess.fork(hostPath, [], {
      serviceName: "PrivateTranscribe Parakeet",
    });
  }
  // Benchmarks and smoke tests run under plain Node, with the same crash boundary.
  const child = require("child_process").fork(hostPath, [], {
    serialization: "advanced",
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    windowsHide: true,
  });
  child.postMessage = (message) => child.send(message);
  return child;
}

class ParakeetClient {
  /**
   * @param {object} [options]
   * @param {(modelName: string) => string} [options.getModelDir] where a model's files live
   */
  constructor({ getModelDir } = {}) {
    this.getModelDir =
      getModelDir ||
      ((modelName) =>
        path.join(require("./modelDirUtils").getModelsDirForService("parakeet"), modelName));
    this.child = null;
    this.inflight = null;
    this.queue = [];
    this.nextId = 1;

    this.modelName = null;
    this.numThreads = null;
    this.loaded = false;
    this.loading = null;
    this.lastError = null;
    this.lastLoadMs = null;

    this.activeRequests = 0;
    this.lastUsedTime = null;
    this.idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MINUTES * 60 * 1000;
    this.idleTimer = null;
    this.stoppedDueToIdle = false;
  }

  isModelDownloaded(modelName = DEFAULT_MODEL) {
    return isModelDirComplete(this.getModelDir(modelName));
  }

  // ---------------------------------------------------------------- lifecycle

  /** Load the model; resolves to a status object and never throws. */
  async start(modelName = DEFAULT_MODEL) {
    try {
      const loaded = await this._ensureLoaded(modelName);
      return { success: true, modelName, ...loaded };
    } catch (error) {
      return { success: false, reason: error.message, code: error.code || null };
    }
  }

  /** Kill the child; the next request spawns a fresh one and reloads. */
  async stop() {
    this._clearIdleTimer();
    this.loaded = false;
    this.loading = null;
    this.modelName = null;
    const child = this.child;
    this.child = null;
    this._rejectAll(typedError("parakeet-stopped", "Parakeet engine was stopped"));
    if (child) {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    }
    return { success: true };
  }

  setIdleTimeoutMinutes(minutes) {
    const parsed = Number(minutes);
    this.idleTimeoutMs =
      Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) * 60 * 1000 : 0;
    this._scheduleIdleCheck();
    return { success: true };
  }

  getStatus() {
    return {
      available: true,
      running: this.loaded && this.child !== null,
      loading: this.loading !== null,
      modelName: this.modelName,
      numThreads: this.numThreads,
      loadMs: this.lastLoadMs,
      idleTimeoutMinutes: this.idleTimeoutMs > 0 ? this.idleTimeoutMs / 60000 : 0,
      lastUsedTime: this.lastUsedTime,
      stoppedDueToIdle: this.stoppedDueToIdle,
      error: this.lastError,
    };
  }

  // ------------------------------------------------------------------- work

  /**
   * @param {Buffer} audioBuffer the recording, as the transcribe IPC receives it
   * @param {{ model?: string, signal?: AbortSignal, languages?: string[] }} [options]
   *   languages: what the user speaks, for the filler filter
   */
  async transcribe(audioBuffer, options = {}) {
    const modelName = options.model || DEFAULT_MODEL;
    if (!this.isModelDownloaded(modelName)) {
      throw typedError(
        "model_not_found",
        `Parakeet model "${modelName}" not downloaded. Please download it from Settings.`
      );
    }

    this._beginRequest();
    try {
      // Load while the audio is being prepared; both usually take a while.
      const loading = this._ensureLoaded(modelName);
      loading.catch(() => {});

      const prepared = await this._prepareAudio(audioBuffer, { signal: options.signal });
      // speechFound can be false while chunks hold a quiet utterance the detector
      // missed; a missed detection must never erase it, so only no chunks means silence.
      if (!prepared.chunks?.length) {
        return { success: true, text: "", noSpeech: true, durationSec: prepared.durationSec };
      }

      await loading;
      const startedAt = Date.now();
      const texts = [];
      for (const samples of prepared.chunks) {
        const { text } = await this._call("decode", {
          samples,
          sampleRate: prepared.sampleRate,
        });
        if (text && text.trim()) texts.push(text.trim());
      }
      const decodeMs = Date.now() - startedAt;
      const text = removeFillerWords(texts.join(" ").trim(), { languages: options.languages });

      debugLogger.logSTTPipeline("Parakeet decode complete", {
        chunks: prepared.chunks.length,
        durationSec: prepared.durationSec,
        decodeMs,
        textLength: text.length,
      });

      if (!text) {
        return { success: true, text: "", noSpeech: true, durationSec: prepared.durationSec };
      }
      return { success: true, text, durationSec: prepared.durationSec, decodeMs };
    } finally {
      this._endRequest();
    }
  }

  /** Decode the bundled 10 s clip once to warm up, then time a second decode. */
  async speedTest(modelName = DEFAULT_MODEL) {
    if (!this.isModelDownloaded(modelName)) {
      return {
        success: false,
        error: "model_not_found",
        message: `Parakeet model "${modelName}" not downloaded`,
      };
    }
    const wavPath = resolveBenchmarkWavPath();
    if (!wavPath) {
      return { success: false, error: "benchmark_missing", message: "benchmark.wav not found" };
    }

    this._beginRequest();
    try {
      const { samples, sampleRate } = await readBenchmarkSamples(wavPath);
      const audioSec = samples.length / sampleRate;
      await this._ensureLoaded(modelName);
      await this._call("decode", { samples, sampleRate });

      const startedAt = this._now();
      await this._call("decode", { samples, sampleRate });
      const decodeMs = Math.round(this._now() - startedAt);

      const result = {
        success: true,
        decodeMs,
        audioSec,
        thresholdMs: SPEED_TEST_THRESHOLD_MS,
        passed: decodeMs <= SPEED_TEST_THRESHOLD_MS,
      };
      debugLogger.info("Parakeet speed test", { ...result, numThreads: this.numThreads });
      return result;
    } catch (error) {
      return { success: false, error: error.code || "speed_test_failed", message: error.message };
    } finally {
      this._endRequest();
    }
  }

  // ---------------------------------------------------------------- internals

  /** Test seam; the chunks come from parakeetAudio.js. */
  _prepareAudio(audioBuffer, options) {
    return require("./parakeetAudio").prepareParakeetAudio(audioBuffer, options);
  }

  _now() {
    return performance.now();
  }

  /** Test seam for the child process. */
  _spawnHost() {
    return createHostProcess();
  }

  _ensureLoaded(modelName) {
    if (this.loaded && this.child && this.modelName === modelName) {
      return Promise.resolve({ alreadyLoaded: true, numThreads: this.numThreads });
    }
    if (this.loading && this.loading.modelName === modelName) return this.loading.promise;

    const modelDir = this.getModelDir(modelName);
    if (!isModelDirComplete(modelDir)) {
      return Promise.reject(
        typedError("model_not_found", `Parakeet model "${modelName}" not downloaded`)
      );
    }

    const numThreads = resolveParakeetThreads();
    const loading = { modelName, promise: null };
    loading.promise = this._call("load", { modelDir, numThreads }).then(
      (result) => {
        if (this.loading !== loading) {
          throw typedError("parakeet-stopped", "Parakeet engine was stopped while loading");
        }
        this.loading = null;
        this.loaded = true;
        this.modelName = modelName;
        this.numThreads = result?.numThreads ?? numThreads;
        this.lastLoadMs = result?.loadMs ?? null;
        this.lastError = null;
        this.stoppedDueToIdle = false;
        this._touch();
        debugLogger.info("Parakeet model loaded", { modelName, ...result });
        return { alreadyLoaded: false, ...result };
      },
      (error) => {
        if (this.loading === loading) this.loading = null;
        this.lastError = error.message;
        throw error;
      }
    );
    this.loaded = false;
    this.loading = loading;
    return loading.promise;
  }

  _beginRequest() {
    this.activeRequests += 1;
    this._clearIdleTimer();
  }

  _endRequest() {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this._touch();
  }

  _touch() {
    this.lastUsedTime = Date.now();
    this._scheduleIdleCheck();
  }

  _clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  _scheduleIdleCheck() {
    this._clearIdleTimer();
    if (!this.loaded || this.idleTimeoutMs <= 0) return;
    const idleForMs = Date.now() - (this.lastUsedTime || Date.now());
    const remainingMs = Math.max(0, this.idleTimeoutMs - idleForMs);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.checkIdleAndStop().catch((error) => {
        debugLogger.warn("Parakeet idle check failed", { error: error.message });
      });
    }, remainingMs);
    this.idleTimer.unref?.();
  }

  async checkIdleAndStop() {
    if (!this.loaded || this.idleTimeoutMs <= 0) return false;
    if (this.activeRequests > 0) {
      this._touch();
      return false;
    }
    const idleForMs = Date.now() - (this.lastUsedTime || 0);
    if (idleForMs < this.idleTimeoutMs) {
      this._scheduleIdleCheck();
      return false;
    }
    debugLogger.info("Unloading Parakeet after inactivity", {
      idleForMs,
      idleTimeoutMs: this.idleTimeoutMs,
    });
    await this.stop();
    this.stoppedDueToIdle = true;
    return true;
  }

  // ------------------------------------------------------------ child + RPC

  _call(op, args) {
    return new Promise((resolve, reject) => {
      this.queue.push({ op, args, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    if (this.inflight || this.queue.length === 0) return;
    const job = this.queue.shift();

    let child;
    try {
      child = this._ensureChild();
    } catch (error) {
      job.reject(typedError("parakeet-host-unavailable", error.message));
      this._pump();
      return;
    }

    const id = this.nextId++;
    const op = job.op;
    const timer = setTimeout(() => {
      if (this.inflight?.id !== id) return;
      this.inflight = null;
      job.reject(typedError("parakeet-timeout", `Parakeet ${op} timed out`));
      // A child that swallowed a request is not trustworthy; start fresh.
      this._discardChild(child, typedError("parakeet-timeout", "Parakeet engine timed out"));
    }, REQUEST_TIMEOUT_MS);

    this.inflight = {
      id,
      resolve: (value) => {
        clearTimeout(timer);
        job.resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        job.reject(error);
      },
    };
    try {
      child.postMessage({ id, op, args: job.args });
    } catch (error) {
      this._discardChild(child, typedError("parakeet-host-unavailable", error.message));
    }
  }

  _onChildMessage(child, msg) {
    if (child !== this.child) return;
    const current = this.inflight;
    if (!current || !msg || msg.id !== current.id) return;
    this.inflight = null;
    if (msg.ok) {
      current.resolve(msg.result);
    } else {
      current.reject(typedError(msg.error?.code || "parakeet-host-error", msg.error?.message));
    }
    this._pump();
  }

  _ensureChild() {
    if (this.child) return this.child;
    const child = this._spawnHost();
    child.on("message", (msg) => this._onChildMessage(child, msg));
    child.once("exit", (code) => {
      if (child !== this.child) return;
      debugLogger.warn("Parakeet host exited", { code, pid: child.pid });
      this._discardChild(
        child,
        typedError("parakeet-host-exited", `Parakeet engine exited with code ${code}`)
      );
    });
    child.once?.("error", (error) => {
      if (child !== this.child) return;
      this._discardChild(child, typedError("parakeet-host-exited", error?.message || "error"));
    });
    this.child = child;
    return child;
  }

  /** Drop a dead or untrusted child and fail everything that was waiting on it. */
  _discardChild(child, error) {
    if (child === this.child) {
      this.child = null;
      this.loaded = false;
      this.loading = null;
      this.modelName = null;
      this.lastError = error.message;
      this._clearIdleTimer();
    }
    this._rejectAll(error);
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }

  _rejectAll(error) {
    const inflight = this.inflight;
    this.inflight = null;
    if (inflight) inflight.reject(error);
    const queued = this.queue;
    this.queue = [];
    for (const job of queued) job.reject(error);
  }
}

module.exports = ParakeetClient;
module.exports.DEFAULT_MODEL = DEFAULT_MODEL;
module.exports.REQUEST_TIMEOUT_MS = REQUEST_TIMEOUT_MS;
module.exports.SPEED_TEST_THRESHOLD_MS = SPEED_TEST_THRESHOLD_MS;
module.exports.REQUIRED_MODEL_FILES = REQUIRED_MODEL_FILES;
module.exports.isModelDirComplete = isModelDirComplete;
module.exports.resolveParakeetThreads = resolveParakeetThreads;
module.exports.resolveBenchmarkWavPath = resolveBenchmarkWavPath;
