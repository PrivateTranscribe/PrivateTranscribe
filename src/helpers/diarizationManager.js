const fs = require("fs");
const fsPromises = require("fs").promises;
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const debugLogger = require("./debugLogger");
const { getModelsDirForService } = require("./modelDirUtils");
const { downloadFile } = require("./downloadUtils");

const DEFAULT_BUNDLE_ID = "sherpa-onnx-multilingual-v1";
const DEFAULT_SEGMENTATION_RELATIVE_PATH = path.join(
  "sherpa-onnx-pyannote-segmentation-3-0",
  "model.int8.onnx"
);
const DEFAULT_EMBEDDING_RELATIVE_PATH = "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx";
const SEGMENTATION_ARCHIVE_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2";
const EMBEDDING_MODEL_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx";

function copyFloat32Samples(samples) {
  if (samples instanceof Float32Array) {
    const copy = new Float32Array(samples.length);
    copy.set(samples);
    return copy;
  }
  return Float32Array.from(samples || []);
}

function toFiniteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSpeakerId(value) {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= 0) {
    return `SPEAKER_${String(numeric).padStart(2, "0")}`;
  }
  const raw = String(value ?? "0");
  const match = raw.match(/(\d+)/);
  if (match) return `SPEAKER_${String(Number(match[1])).padStart(2, "0")}`;
  return raw.toUpperCase().replace(/[\s-]+/g, "_");
}

function normalizeDiarizationResult(segments, meta = {}) {
  const normalizedSegments = (Array.isArray(segments) ? segments : []).map((segment, index) => {
    const start = Math.max(0, toFiniteNumber(segment.start, 0));
    const end = Math.max(start, toFiniteNumber(segment.end, start));
    const speaker = normalizeSpeakerId(segment.speaker ?? segment.label ?? segment.speakerLabel ?? 0);
    return {
      id: index,
      speaker,
      label: String(segment.speaker ?? segment.label ?? segment.speakerLabel ?? 0),
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
    };
  }).filter((segment) => segment.end > segment.start);

  const speakers = Array.from(new Set(normalizedSegments.map((segment) => segment.speaker)));
  return {
    success: true,
    engine: "sherpa-onnx",
    bundleId: meta.bundleId || DEFAULT_BUNDLE_ID,
    speakerCount: speakers.length,
    speakers,
    segments: normalizedSegments,
    elapsedMs: meta.elapsedMs ?? null,
    durationSec: meta.durationSec ?? null,
    rtf:
      Number.isFinite(meta.elapsedMs) && Number.isFinite(meta.durationSec) && meta.durationSec > 0
        ? Number((meta.elapsedMs / 1000 / meta.durationSec).toFixed(3))
        : null,
    model: meta.model || null,
    config: meta.config || null,
  };
}

class DiarizationManager {
  constructor(options = {}) {
    this.modelsDir = options.modelsDir || process.env.PRIVATETRANSCRIBE_DIARIZATION_MODELS_DIR || getModelsDirForService("diarization");
    this.bundleId = options.bundleId || DEFAULT_BUNDLE_ID;
    this.segmentationRelativePath = options.segmentationRelativePath || DEFAULT_SEGMENTATION_RELATIVE_PATH;
    this.embeddingRelativePath = options.embeddingRelativePath || DEFAULT_EMBEDDING_RELATIVE_PATH;
    this.loadSherpa = options.loadSherpa || (() => require("sherpa-onnx-node"));
  }

  getModelPaths() {
    return {
      modelsDir: this.modelsDir,
      segmentationModel: path.join(this.modelsDir, this.segmentationRelativePath),
      embeddingModel: path.join(this.modelsDir, this.embeddingRelativePath),
    };
  }

  getModelStatus() {
    const paths = this.getModelPaths();
    const missing = [paths.segmentationModel, paths.embeddingModel].filter((file) => !fs.existsSync(file));
    return {
      bundleId: this.bundleId,
      ready: missing.length === 0,
      missing,
      ...paths,
    };
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
      const child = spawn("tar", ["-xjf", archivePath, "-C", destinationDir], {
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

  buildConfig(options = {}) {
    const status = this.getModelStatus();
    if (!status.ready) {
      const missingList = status.missing.map((file) => path.basename(file)).join(", ");
      throw new Error(`Diarization models are not downloaded yet (${missingList}).`);
    }

    const expectedSpeakers = Number.isInteger(options.expectedSpeakers) && options.expectedSpeakers > 0
      ? options.expectedSpeakers
      : -1;
    const threshold = toFiniteNumber(options.threshold, 0.9);

    return {
      segmentation: { pyannote: { model: status.segmentationModel } },
      embedding: { model: status.embeddingModel },
      clustering: {
        numClusters: expectedSpeakers,
        threshold,
      },
      minDurationOn: toFiniteNumber(options.minDurationOn, 0.2),
      minDurationOff: toFiniteNumber(options.minDurationOff, 0.5),
    };
  }

  async diarizeWavBuffer(wavBuffer, options = {}) {
    if (!Buffer.isBuffer(wavBuffer)) {
      throw new Error("diarizeWavBuffer expects a WAV Buffer.");
    }

    const tempPath = path.join(os.tmpdir(), `privatetranscribe-diarization-${crypto.randomUUID()}.wav`);
    fs.writeFileSync(tempPath, wavBuffer);
    try {
      return await this.diarizeWavFile(tempPath, options);
    } finally {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // ignore cleanup failures
      }
    }
  }

  async diarizeWavFile(wavPath, options = {}) {
    const config = this.buildConfig(options);
    const status = this.getModelStatus();
    const startedAt = Date.now();

    try {
      const sherpa = this.loadSherpa();
      const diarizer = new sherpa.OfflineSpeakerDiarization(config);
      // Electron >= 21 disallows native external buffers. sherpa-onnx supports
      // opting out via the second readWave argument; without this, Electron apps
      // fail with "External buffers are not allowed" while plain Node CLIs work.
      // See sherpa-onnx FAQ: readWave(filename, false).
      const wave = sherpa.readWave(wavPath, false);
      if (diarizer.sampleRate !== wave.sampleRate) {
        throw new Error(`Diarization expects ${diarizer.sampleRate} Hz audio, got ${wave.sampleRate} Hz.`);
      }

      // Keep a defensive copy as well. It is cheap compared with diarization and
      // protects against runtimes/addon versions that still expose external data.
      const rawSegments = diarizer.process(copyFloat32Samples(wave.samples));
      const elapsedMs = Date.now() - startedAt;
      const durationSec = wave.samples.length / wave.sampleRate;
      const result = normalizeDiarizationResult(rawSegments, {
        bundleId: this.bundleId,
        elapsedMs,
        durationSec,
        model: {
          segmentation: status.segmentationModel,
          embedding: status.embeddingModel,
        },
        config: {
          numClusters: config.clustering.numClusters,
          threshold: config.clustering.threshold,
          minDurationOn: config.minDurationOn,
          minDurationOff: config.minDurationOff,
        },
      });

      debugLogger.info("Local diarization completed", {
        speakerCount: result.speakerCount,
        segments: result.segments.length,
        elapsedMs,
        rtf: result.rtf,
      });
      return result;
    } catch (error) {
      debugLogger.warn("Local diarization failed", { error: error.message });
      throw error;
    }
  }
}

module.exports = {
  DiarizationManager,
  DEFAULT_BUNDLE_ID,
  DEFAULT_EMBEDDING_RELATIVE_PATH,
  DEFAULT_SEGMENTATION_RELATIVE_PATH,
  EMBEDDING_MODEL_URL,
  SEGMENTATION_ARCHIVE_URL,
  copyFloat32Samples,
  normalizeDiarizationResult,
  normalizeSpeakerId,
};
