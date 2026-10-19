// Loaded with `node --require` to give a plain Node process what an installed
// build's ELECTRON_RUN_AS_NODE child has: no electron package. Development
// checkouts resolve require("electron") from node_modules, which is how a worker
// that imported it passed every test and failed for every installed user.
//
// PT_TEST_FAKE_SHERPA=1 also swaps sherpa-onnx-node for a stand-in that hears
// two speakers, so the worker can finish a run without the real models.
const Module = require("module");

const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "electron") {
    const error = new Error(`Cannot find module '${request}'`);
    error.code = "MODULE_NOT_FOUND";
    throw error;
  }
  return resolveFilename.call(this, request, ...rest);
};

if (process.env.PT_TEST_FAKE_SHERPA === "1") {
  const fakeSherpa = {
    readWave: () => ({ sampleRate: 16000, samples: new Float32Array(16000 * 10) }),
    OfflineSpeakerDiarization: class {
      constructor(config) {
        this.config = config;
        this.sampleRate = 16000;
      }

      process() {
        return [
          { start: 0, end: 4.5, speaker: 0 },
          { start: 4.5, end: 9.5, speaker: 1 },
        ];
      }
    },
  };
  const load = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "sherpa-onnx-node") return fakeSherpa;
    return load.call(this, request, ...rest);
  };
}
