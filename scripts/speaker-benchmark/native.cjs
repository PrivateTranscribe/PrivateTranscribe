const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DiarizationManager } = require("../../src/helpers/diarizationManager");
const { assignSpeakersToSegments } = require("../../src/helpers/diarizationMerge");
const { formatTranscript } = require("../../src/helpers/transcriptFormatter");

async function main() {
  const job = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  let result;
  if (job.mode === "asr") {
    const WhisperManager = require("../../src/helpers/whisper");
    const manager = new WhisperManager();
    try {
      await manager.serverManager.setForceCpu(true);
      result = await manager.transcribeLocalWhisper(fs.readFileSync(job.audio), {
        model: "base",
        language: "en",
        fileMode: true,
        noiseReduction: false,
        inputFileName: path.basename(job.audio),
      });
      if (!result.success) throw new Error(result.error || "Transcription failed");
    } finally {
      await manager.serverManager.stop();
    }
  } else if (job.mode === "merge") {
    const asr = JSON.parse(fs.readFileSync(job.asr, "utf8"));
    const diarization = JSON.parse(fs.readFileSync(job.diarization, "utf8"));
    const segments = assignSpeakersToSegments(asr.segments, diarization.segments);
    const words = JSON.parse(fs.readFileSync(job.referenceWords, "utf8"));
    result = {
      transcript: formatTranscript({ segments }, "speakers"),
      referenceWordAssignments: assignSpeakersToSegments(words, diarization.segments),
    };
  } else {
    const manager = new DiarizationManager(
      job.sherpaModule ? { loadSherpa: () => require(job.sherpaModule) } : {}
    );
    if (job.embedding) {
      manager.embeddingRelativePath = path.relative(manager.modelsDir, path.resolve(job.embedding));
      manager.bundleId = "sherpa-wespeaker-evaluation";
    }
    result = await manager.diarizeWavFile(job.audio, job.options || {});
    result.nativeVersion = require(
      job.sherpaModule
        ? path.join(job.sherpaModule, "package.json")
        : "sherpa-onnx-node/package.json"
    ).version;
    result.modelSha256 = Object.fromEntries(
      Object.entries(manager.getModelPaths())
        .filter(([, file]) => fs.statSync(file).isFile())
        .map(([key, file]) => [
          key,
          crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
        ])
    );
    result.modelBytes = Object.values(manager.getModelPaths())
      .filter((file) => fs.statSync(file).isFile())
      .reduce((total, file) => total + fs.statSync(file).size, 0);
  }
  fs.writeFileSync(job.output, JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
