"use strict";

const { parentPort, workerData } = require("worker_threads");
const fs = require("fs");
const crypto = require("crypto");
const { prepareSpeechPcm, detectSpeechRegions, MODEL_SHA256 } = require("./dictationSpeech");

try {
  const hash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(workerData.modelPath))
    .digest("hex");
  if (hash !== MODEL_SHA256) throw new Error("Speech detection model failed integrity check");
  const pcm = Buffer.from(workerData.pcm);
  const regions = detectSpeechRegions(pcm, workerData.modelPath);
  const result = prepareSpeechPcm(pcm, regions);
  const output = Uint8Array.from(result.pcm);
  parentPort.postMessage({ ok: true, pcm: output, mode: result.mode, regions: result.regions }, [
    output.buffer,
  ]);
} catch (error) {
  parentPort.postMessage({ ok: false, error: error?.message || "Speech detection failed" });
}
