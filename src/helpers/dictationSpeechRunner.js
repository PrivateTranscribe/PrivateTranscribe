"use strict";

const path = require("path");
const fs = require("fs");
const { Worker } = require("worker_threads");

function resolveSpeechModelPath(resourcesPath = process.resourcesPath) {
  const candidates = [
    ...(resourcesPath ? [path.join(resourcesPath, "models", "silero-vad.onnx")] : []),
    path.join(__dirname, "..", "..", "resources", "models", "silero-vad.onnx"),
  ];
  return candidates.find((file) => fs.existsSync(file)) || null;
}

// CPU speech detection must not block the main process, hotkeys, or IPC. It is
// optional assistance: failure returns the original audio to the existing path.
function prepareDictationSpeech(
  pcm,
  { signal, timeoutMs = 30000, modelPath = resolveSpeechModelPath() } = {}
) {
  if (!modelPath || signal?.aborted)
    return Promise.resolve({
      available: false,
      reason: signal?.aborted ? "cancelled" : "model-unavailable",
    });
  return new Promise((resolve) => {
    let worker;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      worker?.terminate().catch(() => {});
      resolve(result);
    };
    const onAbort = () => finish({ available: false, reason: "cancelled" });
    const timer = setTimeout(() => finish({ available: false, reason: "timeout" }), timeoutMs);
    try {
      const input = Uint8Array.from(pcm);
      worker = new Worker(path.join(__dirname, "dictationSpeechWorker.js"), {
        workerData: { pcm: input, modelPath },
        transferList: [input.buffer],
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      worker.once("message", (message) => {
        if (!message?.ok || !(message.pcm instanceof Uint8Array)) {
          finish({ available: false, reason: message?.error || "invalid-result" });
          return;
        }
        finish({
          available: true,
          pcm: Buffer.from(message.pcm),
          mode: message.mode,
          regions: message.regions,
        });
      });
      worker.once("error", () => finish({ available: false, reason: "worker-error" }));
      worker.once("exit", () => finish({ available: false, reason: "worker-exited" }));
    } catch {
      finish({ available: false, reason: "worker-unavailable" });
    }
  });
}

module.exports = { prepareDictationSpeech, resolveSpeechModelPath };
