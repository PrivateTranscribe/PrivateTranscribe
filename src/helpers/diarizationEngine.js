// Local speaker diarization itself: model paths, sherpa-onnx config, the native
// run and the clean-up of its clusters. It runs inside diarizationWorker.js,
// which an installed build starts as PrivateTranscribe.exe with
// ELECTRON_RUN_AS_NODE=1. The electron package is not shipped, so
// require("electron") fails there, and this module must not import it, directly
// or through another helper (debugLogger and modelDirUtils both do). Whatever
// the app knows, such as the models folder, arrives as constructor options.
// tests/unit/helpers/diarizationWorker.test.ts runs the worker with electron
// unresolvable to keep it that way.
const fs = require("fs");
const path = require("path");
const {
  centroid,
  clusterDurations,
  reassignSmallClusters,
  representativeSegments,
  selectSmallClusters,
} = require("./diarizationClusters");

const DEFAULT_BUNDLE_ID = "sherpa-onnx-multilingual-v1";
// Automatic counting: clusters shorter than both floors are attached to the most
// similar remaining voice instead of becoming an extra speaker. Values were
// chosen on the AMI excerpts and simulated Danish conversations of
// scripts/speaker-benchmark.
const DEFAULT_MIN_CLUSTER_SECONDS = 4;
const DEFAULT_MIN_CLUSTER_SHARE = 0.05;
// Longest audio embedded per representative segment; bounds the extra work.
const MAX_EMBED_SECONDS = 6;
const DEFAULT_SEGMENTATION_RELATIVE_PATH = path.join(
  "sherpa-onnx-pyannote-segmentation-3-0",
  "model.int8.onnx"
);
const DEFAULT_EMBEDDING_RELATIVE_PATH =
  "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx";

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
  const normalizedSegments = (Array.isArray(segments) ? segments : [])
    .map((segment, index) => {
      const start = Math.max(0, toFiniteNumber(segment.start, 0));
      const end = Math.max(start, toFiniteNumber(segment.end, start));
      const speaker = normalizeSpeakerId(
        segment.speaker ?? segment.label ?? segment.speakerLabel ?? 0
      );
      return {
        id: index,
        speaker,
        label: String(segment.speaker ?? segment.label ?? segment.speakerLabel ?? 0),
        start: Number(start.toFixed(3)),
        end: Number(end.toFixed(3)),
      };
    })
    .filter((segment) => segment.end > segment.start);

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

class DiarizationEngine {
  constructor(options = {}) {
    if (!options.modelsDir) {
      throw new Error("The speaker engine was started without a models folder.");
    }
    this.modelsDir = options.modelsDir;
    this.bundleId = options.bundleId || DEFAULT_BUNDLE_ID;
    this.segmentationRelativePath =
      options.segmentationRelativePath || DEFAULT_SEGMENTATION_RELATIVE_PATH;
    this.embeddingRelativePath = options.embeddingRelativePath || DEFAULT_EMBEDDING_RELATIVE_PATH;
    this.loadSherpa = options.loadSherpa || (() => require("sherpa-onnx-node"));
    this.logger = options.logger || console;
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
    const missing = [paths.segmentationModel, paths.embeddingModel].filter(
      (file) => !fs.existsSync(file)
    );
    return {
      bundleId: this.bundleId,
      ready: missing.length === 0,
      missing,
      ...paths,
    };
  }

  buildConfig(options = {}) {
    const status = this.getModelStatus();
    if (!status.ready) {
      const missingList = status.missing.map((file) => path.basename(file)).join(", ");
      throw new Error(`Diarization models are not downloaded yet (${missingList}).`);
    }

    const expectedSpeakers =
      Number.isInteger(options.expectedSpeakers) && options.expectedSpeakers > 0
        ? options.expectedSpeakers
        : -1;
    const threshold = toFiniteNumber(options.threshold, 0.9);
    if (threshold <= 0 || threshold > 1) {
      throw new Error("Speaker detection threshold must be greater than 0 and at most 1.");
    }

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

  // Dissolve tiny clusters by voice similarity. Uses the diarizer's own embedding
  // model on the longest few segments of every cluster, so the extra cost stays
  // bounded on long meetings. Any failure here keeps the unmerged result.
  mergeSmallClusters(sherpa, embeddingModel, segments, samples, sampleRate, options = {}) {
    const floors = {
      minClusterSeconds: toFiniteNumber(options.minClusterSeconds, DEFAULT_MIN_CLUSTER_SECONDS),
      minClusterShare: toFiniteNumber(options.minClusterShare, DEFAULT_MIN_CLUSTER_SHARE),
    };
    const { small, large, floor } = selectSmallClusters(clusterDurations(segments), floors);
    const base = { segments, merges: [], floor: Number(floor.toFixed(3)), ...floors };
    if (!small.size || !large.size) return base;
    try {
      const extractor = new sherpa.SpeakerEmbeddingExtractor({
        model: embeddingModel,
        numThreads: 2,
      });
      const embed = (segment) => {
        let start = toFiniteNumber(segment.start, 0);
        let end = toFiniteNumber(segment.end, start);
        if (end - start > MAX_EMBED_SECONDS) {
          const middle = (start + end) / 2;
          start = middle - MAX_EMBED_SECONDS / 2;
          end = middle + MAX_EMBED_SECONDS / 2;
        }
        const from = Math.max(0, Math.floor(start * sampleRate));
        const to = Math.min(samples.length, Math.ceil(end * sampleRate));
        if (to - from < sampleRate * 0.1) return null;
        const stream = extractor.createStream();
        stream.acceptWaveform({ samples: samples.slice(from, to), sampleRate });
        return extractor.compute(stream, false);
      };
      const centroids = new Map();
      for (const id of [...small, ...large]) {
        const entries = representativeSegments(segments, id).map((segment) => ({
          vector: embed(segment),
          weight: toFiniteNumber(segment.end, 0) - toFiniteNumber(segment.start, 0),
        }));
        centroids.set(id, centroid(entries));
      }
      const merged = reassignSmallClusters(segments, small, large, centroids);
      if (merged.merges.length) {
        this.logger.info("Diarization merged small clusters by voice", {
          floorSeconds: base.floor,
          merges: merged.merges,
        });
      }
      return { ...base, ...merged };
    } catch (error) {
      this.logger.warn("Diarization small-cluster merge skipped", { error: error.message });
      return base;
    }
  }

  async diarizeWavFile(wavPath, options = {}) {
    const config = this.buildConfig(options);
    const status = this.getModelStatus();
    const startedAt = Date.now();
    const maxAutoSpeakers =
      Number.isInteger(options.maxSpeakers) && options.maxSpeakers > 0 ? options.maxSpeakers : 6;
    let smallClusters = null;

    try {
      const sherpa = this.loadSherpa();
      const diarizer = new sherpa.OfflineSpeakerDiarization(config);
      // Electron >= 21 disallows native external buffers. sherpa-onnx supports
      // opting out via the second readWave argument; without this, Electron apps
      // fail with "External buffers are not allowed" while plain Node CLIs work.
      // See sherpa-onnx FAQ: readWave(filename, false).
      const wave = sherpa.readWave(wavPath, false);
      if (diarizer.sampleRate !== wave.sampleRate) {
        throw new Error(
          `Diarization expects ${diarizer.sampleRate} Hz audio, got ${wave.sampleRate} Hz.`
        );
      }

      // Keep a defensive copy as well. It is cheap compared with diarization and
      // protects against runtimes/addon versions that still expose external data.
      const samples = copyFloat32Samples(wave.samples);
      let rawSegments = diarizer.process(samples);

      // Recluster by voice similarity, never by who happened to speak nearby.
      // Reuse this instance: constructing a second native diarizer can crash.
      if (config.clustering.numClusters <= 0 && Array.isArray(rawSegments)) {
        const uniqueCount = new Set(
          rawSegments.map((seg) => seg.speaker ?? seg.label ?? seg.speakerLabel)
        ).size;
        if (uniqueCount > maxAutoSpeakers) {
          this.logger.info("Diarization auto-detect exceeded max speakers, reclustering", {
            detectedSpeakers: uniqueCount,
            maxAutoSpeakers,
          });
          diarizer.setConfig({
            clustering: { ...config.clustering, numClusters: maxAutoSpeakers },
          });
          rawSegments = diarizer.process(samples);
        }

        smallClusters = this.mergeSmallClusters(
          sherpa,
          status.embeddingModel,
          rawSegments,
          samples,
          wave.sampleRate,
          options
        );
        rawSegments = smallClusters.segments;

        // Renumber speaker IDs sequentially (0, 1, 2, ...) so output labels are
        // "Speaker 1", "Speaker 2", etc. instead of confusing original cluster IDs.
        const seenIds = [];
        for (const seg of rawSegments) {
          const id = String(seg.speaker ?? seg.label ?? seg.speakerLabel ?? 0);
          if (!seenIds.includes(id)) seenIds.push(id);
        }
        if (seenIds.length > 0) {
          const idMap = new Map(seenIds.map((id, idx) => [id, idx]));
          rawSegments = rawSegments.map((seg) => {
            const id = String(seg.speaker ?? seg.label ?? seg.speakerLabel ?? 0);
            return { ...seg, speaker: idMap.get(id) ?? 0 };
          });
        }
      }

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
          minClusterSeconds: smallClusters?.minClusterSeconds ?? null,
          minClusterShare: smallClusters?.minClusterShare ?? null,
        },
      });
      result.smallClusterMerges = smallClusters?.merges ?? [];

      this.logger.info("Local diarization completed", {
        speakerCount: result.speakerCount,
        segments: result.segments.length,
        elapsedMs,
        rtf: result.rtf,
      });
      return result;
    } catch (error) {
      this.logger.warn("Local diarization failed", { error: error.message });
      throw error;
    }
  }
}

module.exports = {
  DiarizationEngine,
  DEFAULT_BUNDLE_ID,
  DEFAULT_EMBEDDING_RELATIVE_PATH,
  DEFAULT_MIN_CLUSTER_SECONDS,
  DEFAULT_MIN_CLUSTER_SHARE,
  DEFAULT_SEGMENTATION_RELATIVE_PATH,
  copyFloat32Samples,
  normalizeDiarizationResult,
  normalizeSpeakerId,
};
