"use strict";

/**
 * The Danish Piper voice's engine, in a utility process of its own.
 *
 * sherpa-onnx-node ships its own onnxruntime.dll and asks it for ORT API 28.
 * The main process can already hold onnxruntime-node 1.21 (API 21): Read
 * Aloud's sentence splitter imports kokoro-js, which loads it. Windows reuses a
 * loaded DLL by name, so sherpa in the main process got the old runtime and the
 * whole app exited. Here sherpa loads its own.
 *
 * Never require onnxruntime-node, kokoro-js or @huggingface/transformers here.
 *
 * Protocol: {id, op, args} in, {id, ok, result|error} out.
 */

let sherpa = null;
let tts = null;

function typedError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Creates the engine. createAsync keeps the ~1.7 s load off this process's message loop. */
async function load({ model, tokens, dataDir, numThreads } = {}) {
  if (tts) return { alreadyLoaded: true };
  sherpa = sherpa || require("sherpa-onnx-node");
  const startedAt = Date.now();
  tts = await sherpa.OfflineTts.createAsync({
    model: {
      vits: { model, tokens, dataDir },
      numThreads: Math.max(1, Number(numThreads) || 1),
      provider: "cpu",
    },
    maxNumSentences: 1,
  });
  return { loadMs: Date.now() - startedAt };
}

async function speak({ text } = {}) {
  if (!tts) throw typedError("not-loaded", "The Danish voice is not loaded");
  // Electron's V8 refuses buffers that point at native memory, and sherpa
  // hands back one by default ("TTS settlement failed"); a copy it accepts.
  const audio = await tts.generateAsync({
    text: String(text ?? ""),
    sid: 0,
    speed: 1.0,
    enableExternalBuffer: false,
  });
  return { samples: Float32Array.from(audio.samples), sampleRate: audio.sampleRate };
}

const OPS = { load, speak };

async function handle(message) {
  const { id, op, args } = message || {};
  try {
    const handler = OPS[op];
    if (!handler) throw typedError("unknown-op", `Unknown Piper op: ${op}`);
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
  // Plain Node child (scripts and tests): the same protocol over fork IPC.
  process.on("message", async (message) => {
    process.send(await handle(message));
  });
}
