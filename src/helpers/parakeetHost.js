"use strict";

/**
 * Parakeet dictation host — the script parakeetClient.js runs in a utility
 * process. Requests arrive over the parent's message channel, so the engine
 * never opens a network port (the retired sherpa-onnx WebSocket server listened
 * on every interface with no password). A native onnxruntime fault kills only
 * this process; the client reports it and respawns on the next request.
 *
 * Protocol: {id, op, args} in, {id, ok, result|error} out.
 *
 * Never require onnxruntime-node here: sherpa-onnx-node bundles its own ONNX
 * Runtime, and two versions in one process clash.
 */

const path = require("path");

let sherpa = null;
let recognizer = null;
let loaded = null;

function typedError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** The config benchmarked for parakeet-tdt-0.6b-v3 int8 on sherpa-onnx-node 1.13.8. */
function buildRecognizerConfig(modelDir, numThreads) {
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(modelDir, "encoder.int8.onnx"),
        decoder: path.join(modelDir, "decoder.int8.onnx"),
        joiner: path.join(modelDir, "joiner.int8.onnx"),
      },
      tokens: path.join(modelDir, "tokens.txt"),
      modelType: "nemo_transducer",
      numThreads,
      provider: "cpu",
      debug: 0,
    },
    decodingMethod: "greedy_search",
  };
}

async function decodeSamples(samples, sampleRate) {
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate, samples });
  if (typeof recognizer.decodeAsync === "function") {
    return recognizer.decodeAsync(stream);
  }
  recognizer.decode(stream);
  return recognizer.getResult(stream);
}

async function load({ modelDir, numThreads } = {}) {
  if (!modelDir) throw typedError("bad-args", "load needs a modelDir");
  const threads = Math.max(1, Math.floor(Number(numThreads) || 1));
  if (recognizer && loaded?.modelDir === modelDir && loaded?.numThreads === threads) {
    return { ...loaded, alreadyLoaded: true };
  }

  recognizer = null;
  loaded = null;
  sherpa = sherpa || require("sherpa-onnx-node");

  const startedAt = Date.now();
  const config = buildRecognizerConfig(modelDir, threads);
  const created =
    typeof sherpa.OfflineRecognizer.createAsync === "function"
      ? await sherpa.OfflineRecognizer.createAsync(config)
      : new sherpa.OfflineRecognizer(config);
  const loadMs = Date.now() - startedAt;

  // One second of silence, as the old server did: the first real decode then
  // skips onnxruntime's first-run allocations.
  recognizer = created;
  const warmStartedAt = Date.now();
  await decodeSamples(new Float32Array(16000), 16000);
  const warmMs = Date.now() - warmStartedAt;

  loaded = { modelDir, numThreads: threads, loadMs, warmMs, sherpaVersion: sherpa.version };
  return { ...loaded };
}

async function decode({ samples, sampleRate } = {}) {
  if (!recognizer) throw typedError("not-loaded", "Parakeet model is not loaded");
  if (!(samples instanceof Float32Array)) {
    throw typedError("bad-args", "decode needs samples as a Float32Array");
  }
  const result = await decodeSamples(samples, Number(sampleRate) || 16000);
  return { text: String(result?.text || "").trim() };
}

const OPS = {
  load,
  decode,
  unload: () => {
    recognizer = null;
    loaded = null;
    return { unloaded: true };
  },
};

async function handle(message) {
  const { id, op, args } = message || {};
  try {
    const handler = OPS[op];
    if (!handler) throw typedError("unknown-op", `Unknown Parakeet op: ${op}`);
    return { id, ok: true, result: await handler(args || {}) };
  } catch (error) {
    return {
      id,
      ok: false,
      error: { message: String(error?.message || error), code: error?.code || null },
    };
  }
}

if (process.parentPort) {
  process.parentPort.on("message", async (event) => {
    process.parentPort.postMessage(await handle(event.data));
  });
  process.parentPort.start?.();
} else if (process.send) {
  // Plain Node child (benchmarks, smoke tests): same protocol over fork IPC.
  process.on("message", async (message) => {
    process.send(await handle(message));
  });
}
