"use strict";

const path = require("path");
const fs = require("fs");

function createSpeechProcess() {
  const hostPath = path.join(__dirname, "dictationSpeechWorker.js");
  if (process.versions.electron) {
    return require("electron").utilityProcess.fork(hostPath, [], {
      serviceName: "PrivateTranscribe Speech Detection",
      stdio: "ignore",
    });
  }
  // Benchmarks and unit tests run under Node, but need the same crash boundary.
  const child = require("child_process").fork(hostPath, [], {
    serialization: "advanced",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  child.postMessage = (message) => child.send(message);
  return child;
}

function resolveSpeechModelPath(resourcesPath = process.resourcesPath) {
  const candidates = [
    ...(resourcesPath ? [path.join(resourcesPath, "models", "silero-vad.onnx")] : []),
    path.join(__dirname, "..", "..", "resources", "models", "silero-vad.onnx"),
  ];
  return candidates.find((file) => fs.existsSync(file)) || null;
}

// A worker thread shares native memory with the app. A sherpa access violation
// therefore kills the entire app, bypassing error/exit handlers and try/catch.
// Run this optional cleanup in a process so even native faults use the fallback.
function prepareDictationSpeech(
  pcm,
  {
    signal,
    timeoutMs = 30000,
    modelPath = resolveSpeechModelPath(),
    createProcess = createSpeechProcess,
  } = {}
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
      try {
        worker?.kill();
      } catch {
        // The process may have already exited after a native fault.
      }
      resolve(result);
    };
    const onAbort = () => finish({ available: false, reason: "cancelled" });
    const timer = setTimeout(() => finish({ available: false, reason: "timeout" }), timeoutMs);
    try {
      const input = Uint8Array.from(pcm);
      worker = createProcess();
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
      worker.once("spawn", () => {
        if (settled) {
          // kill() before spawn can return false because no PID exists yet.
          try {
            worker.kill();
          } catch {
            // Already gone.
          }
          return;
        }
        try {
          worker.postMessage({ pcm: input, modelPath });
        } catch {
          finish({ available: false, reason: "worker-unavailable" });
        }
      });
      // Abort can arrive while the process is being created.
      if (signal?.aborted) onAbort();
    } catch {
      finish({ available: false, reason: "worker-unavailable" });
    }
  });
}

module.exports = { prepareDictationSpeech, resolveSpeechModelPath };
