const fs = require("fs");
const fsPromises = require("fs").promises;
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const debugLogger = require("./debugLogger");
const { getTarCommand } = require("./systemTar");
const { getModelsDirForService } = require("./modelDirUtils");
const { downloadFile } = require("./downloadUtils");
const { createCancelledError } = require("./whisperServer");
const {
  DiarizationEngine,
  DEFAULT_BUNDLE_ID,
  DEFAULT_EMBEDDING_RELATIVE_PATH,
  DEFAULT_MIN_CLUSTER_SECONDS,
  DEFAULT_MIN_CLUSTER_SHARE,
  DEFAULT_SEGMENTATION_RELATIVE_PATH,
  copyFloat32Samples,
  normalizeDiarizationResult,
  normalizeSpeakerId,
} = require("./diarizationEngine");

const SEGMENTATION_ARCHIVE_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2";
const EMBEDDING_MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx";
// Release assets can be replaced under the same URL, so their bytes are pinned.
// GitHub lists no digest for these older assets: both were hashed from a download
// and cross-checked against the models' Hugging Face copies.
const SEGMENTATION_ARCHIVE_SHA256 =
  "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488";
const EMBEDDING_MODEL_SHA256 = "1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b";

// Adds what needs the app to the engine: the default models folder, model
// downloads, and running the engine in a separate process.
class DiarizationManager extends DiarizationEngine {
  constructor(options = {}) {
    super({
      ...options,
      modelsDir:
        options.modelsDir ||
        process.env.PRIVATETRANSCRIBE_DIARIZATION_MODELS_DIR ||
        getModelsDirForService("diarization"),
      logger: options.logger || debugLogger,
    });
    this.spawn = options.spawn || spawn;
  }

  async downloadModels(onProgress) {
    await fsPromises.mkdir(this.modelsDir, { recursive: true });
    const archivePath = path.join(this.modelsDir, "sherpa-onnx-pyannote-segmentation-3-0.tar.bz2");
    const embeddingPath = path.join(this.modelsDir, this.embeddingRelativePath);

    const emit = (stage, percentage, extra = {}) => {
      if (typeof onProgress === "function") {
        onProgress({ type: "progress", model: this.bundleId, stage, percentage, ...extra });
      }
    };

    emit("segmentation-download", 0);
    await downloadFile(SEGMENTATION_ARCHIVE_URL, archivePath, {
      sha256: SEGMENTATION_ARCHIVE_SHA256,
      onProgress: (downloadedBytes, totalBytes) => {
        const percentage = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 45) : 0;
        emit("segmentation-download", percentage, { downloadedBytes, totalBytes });
      },
    });

    emit("segmentation-extract", 50);
    await this.extractTarBz2(archivePath, this.modelsDir);
    await fsPromises.unlink(archivePath).catch(() => {});

    emit("embedding-download", 55);
    await downloadFile(EMBEDDING_MODEL_URL, embeddingPath, {
      sha256: EMBEDDING_MODEL_SHA256,
      onProgress: (downloadedBytes, totalBytes) => {
        const partial = totalBytes > 0 ? downloadedBytes / totalBytes : 0;
        emit("embedding-download", 55 + Math.round(partial * 44), { downloadedBytes, totalBytes });
      },
    });

    const status = this.getModelStatus();
    if (!status.ready) {
      throw new Error("Diarization model download completed but files are still missing.");
    }
    emit("complete", 100);
    return { success: true, ...status };
  }

  extractTarBz2(archivePath, destinationDir) {
    return new Promise((resolve, reject) => {
      const child = spawn(getTarCommand(), ["-xjf", archivePath, "-C", destinationDir], {
        windowsHide: true,
      });
      let stderr = "";
      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`tar extraction failed with code ${code}: ${stderr.trim()}`));
        }
      });
    });
  }

  async diarizeWavBuffer(wavBuffer, options = {}) {
    if (!Buffer.isBuffer(wavBuffer)) {
      throw new Error("diarizeWavBuffer expects a WAV Buffer.");
    }

    const tempPath = path.join(
      os.tmpdir(),
      `privatetranscribe-diarization-${crypto.randomUUID()}.wav`
    );
    await fs.promises.writeFile(tempPath, wavBuffer);
    try {
      return await this.diarizeWavFile(tempPath, options);
    } finally {
      await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    }
  }

  async diarizeWavBufferInWorker(wavBuffer, options = {}) {
    if (options.signal?.aborted) throw createCancelledError();
    if (!Buffer.isBuffer(wavBuffer)) {
      throw new Error("diarizeWavBufferInWorker expects a WAV Buffer.");
    }

    const tempPath = path.join(
      os.tmpdir(),
      `privatetranscribe-diarization-${crypto.randomUUID()}.wav`
    );
    await fs.promises.writeFile(tempPath, wavBuffer);
    try {
      return await this.diarizeWavFileInWorker(tempPath, options);
    } finally {
      await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    }
  }

  async diarizeWavFileInWorker(wavPath, options = {}) {
    const { signal, ...workerOptions } = options;
    if (signal?.aborted) throw createCancelledError();
    const payloadPath = path.join(
      os.tmpdir(),
      `privatetranscribe-diarization-${crypto.randomUUID()}.json`
    );
    const workerPath = path.join(__dirname, "diarizationWorker.js");
    // Everything the engine would otherwise ask the app for. The worker cannot
    // load Electron, so it has no other way to find the models.
    const payload = {
      wavPath,
      options: workerOptions,
      engineOptions: {
        modelsDir: this.modelsDir,
        bundleId: this.bundleId,
        segmentationRelativePath: this.segmentationRelativePath,
        embeddingRelativePath: this.embeddingRelativePath,
      },
    };
    await fs.promises.writeFile(payloadPath, JSON.stringify(payload));

    try {
      if (signal?.aborted) throw createCancelledError();
      return await new Promise((resolve, reject) => {
        const child = this.spawn(process.execPath, [workerPath, payloadPath], {
          windowsHide: true,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        });
        let stdout = "";
        let stderr = "";
        let cancelled = false;
        const abort = () => {
          cancelled = true;
          child.kill();
        };
        const detach = () => signal?.removeEventListener("abort", abort);
        child.stdout.on("data", (data) => {
          stdout += data.toString();
        });
        child.stderr.on("data", (data) => {
          stderr += data.toString();
        });
        child.on("error", (error) => {
          detach();
          reject(cancelled ? createCancelledError() : error);
        });
        child.on("close", (code) => {
          detach();
          if (cancelled || signal?.aborted) {
            reject(createCancelledError());
            return;
          }
          // Filter out benign Chromium crashpad warnings that always appear on
          // Windows when running Electron with ELECTRON_RUN_AS_NODE.
          const filteredStderr = stderr
            .split(/\r?\n/)
            .filter((line) => !line.includes("crashpad") && !line.includes("not connected"))
            .join("\n")
            .trim();
          let parsed;
          try {
            parsed = JSON.parse(stdout.trim() || "{}");
          } catch (parseError) {
            reject(
              new Error(
                `Diarization worker returned invalid JSON (code ${code}): ${filteredStderr || stdout}`
              )
            );
            return;
          }
          if (code === 0 && parsed.success) {
            resolve(parsed.result);
          } else {
            reject(
              new Error(
                parsed.error || filteredStderr || `Diarization worker exited with code ${code}`
              )
            );
          }
        });
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    } finally {
      await fs.promises.rm(payloadPath, { force: true }).catch(() => {});
    }
  }
}

module.exports = {
  DiarizationManager,
  DEFAULT_BUNDLE_ID,
  DEFAULT_EMBEDDING_RELATIVE_PATH,
  DEFAULT_MIN_CLUSTER_SECONDS,
  DEFAULT_MIN_CLUSTER_SHARE,
  DEFAULT_SEGMENTATION_RELATIVE_PATH,
  EMBEDDING_MODEL_SHA256,
  EMBEDDING_MODEL_URL,
  SEGMENTATION_ARCHIVE_SHA256,
  SEGMENTATION_ARCHIVE_URL,
  copyFloat32Samples,
  normalizeDiarizationResult,
  normalizeSpeakerId,
};
