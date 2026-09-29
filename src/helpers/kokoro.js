/**
 * Kokoro text-to-speech manager (Read Aloud).
 *
 * Runs entirely in the main process: onnxruntime-node holds the model in
 * memory, the renderer only receives PCM. Three rules this file exists to
 * enforce, all of them measured rather than assumed:
 *
 *  - dtype is fp32 on CPU. q8 is ~5x SLOWER on this hardware, and fp16/q4 fail
 *    to load at all. Do not "optimize" the dtype.
 *  - the engine must refuse to load when the model is not on disk.
 *    @huggingface/transformers would otherwise silently download ~326MB from
 *    HuggingFace on first use, which is forbidden — downloads are explicit,
 *    user-initiated, and go through downloadKokoroModel().
 *  - Kokoro truncates at 510 tokens per pass, so long text has to be split
 *    into sentences before synthesis. splitSentences() is not optional.
 */

const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");
const debugLogger = require("./debugLogger");
const { downloadFile, createDownloadSignal } = require("./downloadUtils");
const { getModelsDirForService } = require("./modelDirUtils");
const { synthesizeWithWordTimings } = require("./kokoroWordTimings");

const modelRegistryData = require("../models/modelRegistryData.json");

const DEFAULT_KOKORO_MODEL = "kokoro-82m-v1.0-fp32";
/**
 * Named once here so the cache key in the renderer and the engine agree.
 * Keep in sync with DEFAULT_KOKORO_VOICE_ID in src/models/kokoroVoices.ts —
 * this file is CommonJS in the main process and cannot import that module.
 */
const DEFAULT_KOKORO_VOICE = "bm_lewis";
/** Measured: fp32 beats q8 by ~5x on CPU. See docs/GOALS.md. */
const KOKORO_DTYPE = "fp32";
/**
 * CPU on purpose. DirectML was measured 2026-08-24 and fails outright on this
 * model: onnxruntime's DML execution provider rejects Kokoro's ConvTranspose
 * nodes ("The parameter is incorrect"), so there is no GPU path with the
 * runtime this stack ships. See docs/GOALS.md readaloud-gpu-synthesis.
 */
const KOKORO_DEVICE = "cpu";

/**
 * Cap the ONNX intra-op threadpool on big machines. Measured on the 32-logical
 * dev machine (fixture sentence, warm, medians of 5):
 *
 *   threads   wall(79ch)  wall(26ch)  CPU burned  system busy
 *   16 (def)     511ms       227ms       7.5s        ~55%     ← "lags the PC"
 *   12           521ms       222ms       5.6s        ~44%     ← shipped
 *    8           603ms       271ms       4.2s        ~37%
 *    4           815ms       374ms       3.1s        ~19%
 *
 * 12 threads is free on this machine — synthesis speed is unchanged while a
 * quarter of the CPU burn and ~11 points of system pressure disappear, so the
 * first-audio gate's 350ms bar is untouched. 8 would buy more machine-freedom
 * for +40ms on the first chunk, a trade not taken here.
 * Only machines big enough to be measured (>= 24 logical cores) are capped;
 * everything else keeps onnxruntime's default of one thread per physical core,
 * because a cap tuned on 32 cores is a guess everywhere else.
 */
function kokoroIntraOpThreads() {
  const logical = require("os").cpus().length;
  if (logical < 24) return 0; // 0 = leave onnxruntime's default (physical cores)
  return 12;
}
/** Below this, a file is small enough that "non-empty" is the only useful check. */
const EXACT_SIZE_THRESHOLD_BYTES = 1_000_000;
const SIZE_TOLERANCE = 0.01;
const DOWNLOAD_TIMEOUT_MS = 900_000;

function getKokoroModelInfo(modelId) {
  return modelRegistryData.kokoroModels?.[modelId] || null;
}

function getValidModelIds() {
  return Object.keys(modelRegistryData.kokoroModels || {});
}

/** Errors the renderer has to distinguish, tagged so it does not match on prose. */
function typedError(code, message) {
  return Object.assign(new Error(message), { code });
}

class KokoroManager {
  constructor() {
    this.tts = null;
    this.loadPromise = null;
    this.coldStartMs = 0;
    this.lastError = null;
    this.currentDownloadProcess = null;
  }

  getModelsDir() {
    return getModelsDirForService("kokoro");
  }

  validateModelId(modelId) {
    const valid = getValidModelIds();
    if (!valid.includes(modelId)) {
      throw typedError(
        "invalid-model",
        `Invalid Kokoro model: ${modelId}. Valid models: ${valid.join(", ")}`
      );
    }
    return true;
  }

  /**
   * Directory the transformers cache expects for this repo:
   * `<modelsDir>/<owner>/<repo>`. Files land here so the engine finds them
   * offline instead of fetching them.
   */
  getModelDir(modelId = DEFAULT_KOKORO_MODEL) {
    this.validateModelId(modelId);
    const info = getKokoroModelInfo(modelId);
    return path.join(this.getModelsDir(), ...info.hfRepo.split("/"));
  }

  getFilePath(modelId, relPath) {
    return path.join(this.getModelDir(modelId), ...relPath.split("/"));
  }

  // ------------------------------------------------------------- status

  async checkModelStatus(modelId = DEFAULT_KOKORO_MODEL) {
    this.validateModelId(modelId);
    const info = getKokoroModelInfo(modelId);
    const dir = this.getModelDir(modelId);

    const missingFiles = [];
    let totalBytes = 0;

    for (const file of info.files) {
      const filePath = this.getFilePath(modelId, file.relPath);
      let stats = null;
      try {
        stats = await fsPromises.stat(filePath);
      } catch {
        missingFiles.push(file.relPath);
        continue;
      }

      const size = stats.size;
      const expected = file.bytes;
      const complete =
        expected >= EXACT_SIZE_THRESHOLD_BYTES
          ? Math.abs(size - expected) <= expected * SIZE_TOLERANCE
          : size > 0;

      if (!complete) {
        missingFiles.push(file.relPath);
        continue;
      }
      totalBytes += size;
    }

    return {
      model: modelId,
      installed: missingFiles.length === 0,
      missingFiles,
      totalBytes,
      dir,
    };
  }

  getEngineStatus() {
    return {
      loaded: Boolean(this.tts),
      loading: Boolean(this.loadPromise),
      coldStartMs: this.coldStartMs,
      error: this.lastError,
    };
  }

  // ------------------------------------------------------------- download

  /**
   * Download every registry file for `modelId` into the transformers cache
   * layout. Progress is aggregated across files so the renderer sees one bar.
   */
  async downloadKokoroModel(modelId = DEFAULT_KOKORO_MODEL, progressCallback = null) {
    this.validateModelId(modelId);
    const info = getKokoroModelInfo(modelId);

    const status = await this.checkModelStatus(modelId);
    if (status.installed) {
      if (progressCallback) {
        progressCallback({ type: "complete", model: modelId, percentage: 100 });
      }
      return { model: modelId, downloaded: true, path: status.dir, success: true };
    }

    const grandTotal = info.files.reduce((sum, file) => sum + file.bytes, 0);
    const { signal, abort } = createDownloadSignal();
    this.currentDownloadProcess = { abort };

    let completedBytes = 0;

    try {
      for (const file of info.files) {
        const destPath = this.getFilePath(modelId, file.relPath);
        await fsPromises.mkdir(path.dirname(destPath), { recursive: true });

        // Skip files a previous run already finished, so a resumed download
        // does not re-fetch 326MB because a 44-byte config was interrupted.
        let alreadyComplete = false;
        try {
          const stats = await fsPromises.stat(destPath);
          alreadyComplete =
            file.bytes >= EXACT_SIZE_THRESHOLD_BYTES
              ? Math.abs(stats.size - file.bytes) <= file.bytes * SIZE_TOLERANCE
              : stats.size > 0;
        } catch {
          alreadyComplete = false;
        }

        if (alreadyComplete) {
          completedBytes += file.bytes;
          continue;
        }

        const fileStartBytes = completedBytes;
        await downloadFile(file.url, destPath, {
          timeout: DOWNLOAD_TIMEOUT_MS,
          signal,
          onProgress: (downloadedBytes) => {
            if (!progressCallback) return;
            const overall = fileStartBytes + downloadedBytes;
            progressCallback({
              type: "progress",
              model: modelId,
              downloaded_bytes: overall,
              total_bytes: grandTotal,
              percentage: grandTotal > 0 ? Math.round((overall / grandTotal) * 100) : 0,
            });
          },
        });

        completedBytes += file.bytes;
      }

      if (progressCallback) {
        progressCallback({ type: "installing", model: modelId, percentage: 100 });
      }

      const finalStatus = await this.checkModelStatus(modelId);
      if (!finalStatus.installed) {
        throw typedError(
          "download-incomplete",
          `Kokoro download finished but these files are still missing or truncated: ${finalStatus.missingFiles.join(", ")}`
        );
      }

      if (progressCallback) {
        progressCallback({ type: "complete", model: modelId, percentage: 100 });
      }

      debugLogger.info("Kokoro model downloaded", { modelId, dir: finalStatus.dir });
      return { model: modelId, downloaded: true, path: finalStatus.dir, success: true };
    } catch (error) {
      if (error.isAbort) {
        throw typedError("download-cancelled", "Download interrupted by user");
      }
      throw error;
    } finally {
      this.currentDownloadProcess = null;
    }
  }

  async cancelDownload() {
    if (this.currentDownloadProcess) {
      this.currentDownloadProcess.abort();
      this.currentDownloadProcess = null;
      return { success: true, message: "Download cancelled" };
    }
    return { success: false, error: "No active download to cancel" };
  }

  async deleteModel(modelId = DEFAULT_KOKORO_MODEL) {
    this.validateModelId(modelId);
    const dir = this.getModelDir(modelId);

    if (!fs.existsSync(dir)) {
      return { model: modelId, deleted: false, error: "Model not found", success: false };
    }

    const status = await this.checkModelStatus(modelId);

    // A loaded engine holds file handles on the weights; drop it first.
    this.unloadEngine();

    try {
      await fsPromises.rm(dir, { recursive: true, force: true });
      return {
        model: modelId,
        deleted: true,
        freed_bytes: status.totalBytes,
        freed_mb: Math.round(status.totalBytes / (1024 * 1024)),
        success: true,
      };
    } catch (error) {
      return { model: modelId, deleted: false, error: error.message, success: false };
    }
  }

  // --------------------------------------------------------------- engine

  unloadEngine() {
    this.tts = null;
    this.loadPromise = null;
    this.coldStartMs = 0;
  }

  async loadEngine(modelId = DEFAULT_KOKORO_MODEL) {
    if (this.tts) return this.getEngineStatus();
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = this._loadEngineInner(modelId)
      .then((status) => {
        this.loadPromise = null;
        return status;
      })
      .catch((error) => {
        this.loadPromise = null;
        this.lastError = error.message;
        throw error;
      });

    return this.loadPromise;
  }

  async _loadEngineInner(modelId) {
    this.validateModelId(modelId);
    const info = getKokoroModelInfo(modelId);

    const status = await this.checkModelStatus(modelId);
    if (!status.installed) {
      throw typedError(
        "model-not-installed",
        `Kokoro model "${modelId}" is not installed. Missing: ${status.missingFiles.join(", ") || "everything"}. Download it before using Read Aloud.`
      );
    }

    // Point transformers at our model cache and forbid remote fetches, so a
    // partially-valid cache fails loudly instead of quietly pulling from HF.
    const { env } = await import("@huggingface/transformers");
    env.cacheDir = this.getModelsDir();
    env.allowRemoteModels = false;

    const { KokoroTTS } = await import("kokoro-js");

    const started = Date.now();
    const threads = kokoroIntraOpThreads();

    // kokoro-js's own from_pretrained destructures only {dtype, device,
    // progress_callback} and silently drops session_options, so the thread cap
    // has to go around it: load the model and tokenizer through transformers
    // directly (exactly what kokoro-js does inside) and use KokoroTTS's
    // (model, tokenizer) constructor. If kokoro-js ever changes that shape,
    // loadDefault below still works — uncapped is degraded, not broken.
    const loadCapped = async () => {
      const { StyleTextToSpeech2Model, AutoTokenizer } = await import("@huggingface/transformers");
      const [model, tokenizer] = await Promise.all([
        StyleTextToSpeech2Model.from_pretrained(info.hfRepo, {
          dtype: KOKORO_DTYPE,
          device: KOKORO_DEVICE,
          session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 },
        }),
        AutoTokenizer.from_pretrained(info.hfRepo, {}),
      ]);
      return new KokoroTTS(model, tokenizer);
    };
    const loadDefault = () =>
      KokoroTTS.from_pretrained(info.hfRepo, {
        dtype: KOKORO_DTYPE,
        device: KOKORO_DEVICE,
      });

    // Measured on this machine: the very first load after a fresh download once
    // failed with "failed:system error number 13" and succeeded on an immediate
    // retry. One retry, then the error is real.
    let tts;
    try {
      tts = threads > 0 ? await loadCapped() : await loadDefault();
    } catch (firstError) {
      debugLogger.warn("Kokoro engine load failed, retrying once", {
        error: firstError?.message,
        threads,
      });
      tts = await loadDefault();
    }

    this.tts = tts;
    this.coldStartMs = Date.now() - started;
    this.lastError = null;

    debugLogger.info("Kokoro engine loaded", {
      modelId,
      coldStartMs: this.coldStartMs,
      dtype: KOKORO_DTYPE,
      device: KOKORO_DEVICE,
      intraOpThreads: threads || "default",
    });

    return this.getEngineStatus();
  }

  // ------------------------------------------------------------ synthesis

  /**
   * Split text into sentences using kokoro-js's own splitter, which knows the
   * abbreviation and quote cases a naive `.split(/[.!?]/)` gets wrong.
   */
  async splitSentences(text) {
    const { TextSplitterStream } = await import("kokoro-js");
    const splitter = new TextSplitterStream();
    splitter.push(String(text ?? ""));
    // The iterator flushes the buffered tail before draining.
    return [...splitter];
  }

  async synthesize(
    text,
    { voice = DEFAULT_KOKORO_VOICE, speed = 1.0, withWordTimings = false } = {}
  ) {
    if (!this.tts) {
      await this.loadEngine();
    }
    if (!this.tts) {
      throw typedError("engine-not-loaded", "Kokoro engine is not loaded");
    }

    const started = Date.now();
    const source = String(text ?? "");
    const { audio, wordTimings = [] } = withWordTimings
      ? await synthesizeWithWordTimings(this.tts, source, { voice, speed })
      : { audio: await this.tts.generate(source, { voice, speed }) };
    const synthMs = Date.now() - started;

    return {
      pcm: audio.audio,
      sampleRate: audio.sampling_rate,
      synthMs,
      wordTimings,
    };
  }
}

module.exports = KokoroManager;
module.exports.DEFAULT_KOKORO_MODEL = DEFAULT_KOKORO_MODEL;
module.exports.DEFAULT_KOKORO_VOICE = DEFAULT_KOKORO_VOICE;
