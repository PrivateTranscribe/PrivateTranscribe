import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const WhisperServerManager = require("../../../src/helpers/whisperServer.js") as {
  detectServerBackend: (output: string) => string | null;
  new (): {
    observedBackend: string | null;
    backendScanBuffer: string;
    scanForBackend: (text: string) => void;
    activeServerBinaryPath: string | null;
    ready: boolean;
    getEngineStatus: () => { effectiveEngine: string };
  };
};
const { detectServerBackend } = WhisperServerManager;

/**
 * Captured verbatim from resources/bin/whisper-server-win32-x64.exe on a machine
 * with an RTX 3090. This build is named for the CPU and loads CUDA anyway,
 * because the runtime libraries sit beside it, which is exactly the case the
 * filename cannot see.
 */
const CUDA_STARTUP = `ggml_cuda_init: found 1 CUDA devices:
  Device 0: NVIDIA GeForce RTX 3090, compute capability 8.6, VMM: yes
load_backend: loaded RPC backend from C:\\repo\\resources\\bin\\ggml-rpc.dll
load_backend: loaded CPU backend from C:\\repo\\resources\\bin\\ggml-cpu-zen4.dll
whisper_init_with_params_no_state: use gpu    = 1
whisper_init_with_params_no_state: gpu_device = 0
whisper_model_load:        CUDA0 total size =   147.37 MB
whisper_backend_init_gpu: device 0: CUDA0 (type: 1)
whisper_backend_init_gpu: using CUDA0 backend
whisper server listening at http://127.0.0.1:8178`;

const CPU_STARTUP = `load_backend: loaded CPU backend from C:\\repo\\resources\\bin\\ggml-cpu-haswell.dll
whisper_init_with_params_no_state: use gpu    = 1
whisper_init_with_params_no_state: gpu_device = 0
whisper_model_load:          CPU total size =   147.37 MB
whisper server listening at http://127.0.0.1:8178`;

describe("whisper-server backend detection", () => {
  it("reads CUDA out of output from a binary named for the CPU", () => {
    expect(detectServerBackend(CUDA_STARTUP)).toBe("cuda");
  });

  it("reads CPU when no GPU backend was chosen", () => {
    expect(detectServerBackend(CPU_STARTUP)).toBe("cpu");
  });

  // The weights line is the fallback signal, and it has to survive a server
  // that never prints the backend line at all.
  it("falls back to where the weights were loaded", () => {
    expect(detectServerBackend("whisper_model_load:        CUDA0 total size = 3094.86 MB")).toBe(
      "cuda"
    );
    expect(detectServerBackend("whisper_model_load:          CPU total size = 3094.86 MB")).toBe(
      "cpu"
    );
  });

  it("answers null rather than guessing when the output says nothing", () => {
    expect(detectServerBackend("whisper server listening at http://127.0.0.1:8178")).toBeNull();
    expect(detectServerBackend("")).toBeNull();
    expect(detectServerBackend(undefined as unknown as string)).toBeNull();
  });

  it("still finds the verdict when a line arrives split across chunks", () => {
    const manager = new WhisperServerManager();
    manager.observedBackend = null;
    manager.backendScanBuffer = "";

    const midLine = CUDA_STARTUP.indexOf("using CUDA0") + 6;
    manager.scanForBackend(CUDA_STARTUP.slice(0, midLine));
    manager.scanForBackend(CUDA_STARTUP.slice(midLine));

    expect(manager.observedBackend).toBe("cuda");
  });

  it("prefers what the server reported over what the binary is called", () => {
    const manager = new WhisperServerManager();
    manager.ready = true;
    // A CPU-named binary, which is what the old filename check would have gone by.
    manager.activeServerBinaryPath = "C:\\repo\\resources\\bin\\whisper-server-win32-x64.exe";

    expect(manager.getEngineStatus().effectiveEngine).toBe("cpu");

    manager.scanForBackend(CUDA_STARTUP);
    expect(manager.getEngineStatus().effectiveEngine).toBe("cuda");
  });

  // The reverse case, and the one that reaches real users: a CUDA build that
  // starts cleanly and then runs on the CPU because the driver refused it.
  it("reports CPU for a CUDA binary that fell back after starting", () => {
    const manager = new WhisperServerManager();
    manager.ready = true;
    manager.activeServerBinaryPath = "C:\\engines\\whisper-server-win32-x64-cuda.exe";

    expect(manager.getEngineStatus().effectiveEngine).toBe("cuda");

    manager.scanForBackend(CPU_STARTUP);
    expect(manager.getEngineStatus().effectiveEngine).toBe("cpu");
  });
});
