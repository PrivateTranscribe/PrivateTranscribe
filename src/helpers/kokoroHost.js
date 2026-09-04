/**
 * Kokoro TTS host — the script kokoroClient.js runs inside an Electron
 * utilityProcess.
 *
 * This file exists so synthesis burns its CPU in a child process the OS
 * schedules at below-normal priority (kokoroClient sets it right after spawn),
 * instead of inside the main process at normal priority where a burst of
 * sentence synthesis makes the whole machine stutter. It also moves the
 * JS-side synthesis work (phonemization, tensor prep) off the main process
 * event loop, so the overlay stays smooth while a read is being produced.
 *
 * Protocol: {id, op, args} in, {id, ok, result|error} out. PCM crosses as a
 * Float32Array via structured clone, exactly the shape the renderer already
 * receives over IPC today.
 */

const KokoroManager = require("./kokoro");

const manager = new KokoroManager();

const OPS = {
  "load-engine": (args) => manager.loadEngine(args.modelId || undefined),
  "engine-status": () => manager.getEngineStatus(),
  split: (args) => manager.splitSentences(args.text),
  synth: (args) => manager.synthesize(args.text, args.options || {}),
  unload: () => {
    manager.unloadEngine();
    return { unloaded: true };
  },
};

process.parentPort.on("message", async (event) => {
  const { id, op, args } = event.data || {};
  const handler = OPS[op];
  try {
    if (!handler) {
      throw Object.assign(new Error(`Unknown Kokoro op: ${op}`), { code: "unknown-op" });
    }
    const result = await handler(args || {});
    process.parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    process.parentPort.postMessage({
      id,
      ok: false,
      error: { message: String(error?.message || error), code: error?.code || null },
    });
  }
});

// MessagePortMain queues messages until start() is called; parentPort usually
// starts on listener attach, but calling it explicitly costs nothing.
process.parentPort.start?.();
