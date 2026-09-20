"use strict";

const fs = require("fs");
const crypto = require("crypto");
const { prepareSpeechPcm, detectSpeechRegions, MODEL_SHA256 } = require("./dictationSpeech");

// One request per process. Native sherpa state never enters the main app or a
// worker thread that can take the main app down during inference or teardown.
function prepare(workerData) {
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
    return { ok: true, pcm: output, mode: result.mode, regions: result.regions };
  } catch (error) {
    return { ok: false, error: error?.message || "Speech detection failed" };
  }
}

if (process.parentPort) {
  process.parentPort.once("message", ({ data }) => {
    process.parentPort.postMessage(prepare(data));
  });
} else {
  process.once("message", (data) => process.send(prepare(data)));
}
