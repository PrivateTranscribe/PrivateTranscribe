import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => tmpdir(),
    isReady: () => false,
  },
}));

const WhisperServerManager = require("../../../src/helpers/whisperServer");
const GpuBinaryManager = require("../../../src/helpers/gpuBinaryManager");

describe("WhisperServerManager CUDA startup fallback", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  const makeSilentWav = (durationSeconds: number) => {
    const sampleRate = 16000;
    const channels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const dataSize = durationSeconds * byteRate;
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(36 + dataSize, 4);
    header.write("WAVE", 8, "ascii");
    header.write("fmt ", 12, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write("data", 36, "ascii");
    header.writeUInt32LE(dataSize, 40);
    return Buffer.concat([header, Buffer.alloc(dataSize)]);
  };

  it("splits long WAV files into bounded chunks before whisper-server requests", () => {
    const manager = new WhisperServerManager();
    const longWav = makeSilentWav(40 * 60);

    const chunks = manager._splitWavIntoTranscriptionChunks(longWav);

    expect(chunks).toHaveLength(40);
    expect(
      chunks.every((chunk: { durationSeconds: number }) => chunk.durationSeconds <= 60)
    ).toBe(true);
    expect(
      Math.round(
        chunks.reduce(
          (sum: number, chunk: { durationSeconds: number }) => sum + chunk.durationSeconds,
          0
        )
      )
    ).toBe(40 * 60);
  });

  it("does not split normal-length WAV files", () => {
    const manager = new WhisperServerManager();
    const shortWav = makeSilentWav(5 * 60);

    const chunks = manager._splitWavIntoTranscriptionChunks(shortWav);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].buffer).toBe(shortWav);
  });

  it("restarts a running server when a different model is requested", async () => {
    const manager = new WhisperServerManager();
    const oldModelPath = "/tmp/ggml-large-v3.bin";
    const newModelPath = "/tmp/ggml-large-v3-turbo.bin";

    manager.ready = true;
    manager.process = { pid: 1234 };
    manager.modelPath = oldModelPath;
    manager.loadedModelPath = oldModelPath;
    manager.printRealtimeEnabled = false;
    manager.stop = vi.fn(async () => {
      manager.ready = false;
      manager.process = null;
      manager.loadedModelPath = null;
      manager.modelPath = null;
    });
    manager._doStart = vi.fn(async (modelPath: string) => {
      manager.ready = true;
      manager.process = { pid: 5678 };
      manager.modelPath = modelPath;
      manager.loadedModelPath = modelPath;
      manager.printRealtimeEnabled = false;
    });

    await manager.start(newModelPath);

    expect(manager.stop).toHaveBeenCalledTimes(1);
    expect(manager._doStart).toHaveBeenCalledWith(newModelPath, {});
    expect(manager.loadedModelPath).toBe(newModelPath);
  });

  it("treats spawn UNKNOWN as a recoverable CUDA startup failure", () => {
    const manager = new WhisperServerManager();
    const error = Object.assign(new Error("spawn UNKNOWN"), {
      code: "UNKNOWN",
      syscall: "spawn whisper-server-win32-x64-cuda.exe",
    });

    expect(manager.isRecoverableCudaStartupFailure(error)).toBe(true);
  });

  it("falls back to the CPU binary when CUDA spawn fails", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "pt-whisper-"));
    const modelPath = path.join(tempDir, "ggml-test.bin");
    writeFileSync(modelPath, "model");

    const manager = new WhisperServerManager();
    const cudaPath = path.join(tempDir, "whisper-server-win32-x64-cuda.exe");
    const cpuPath = path.join(tempDir, "whisper-server-win32-x64.exe");
    const startWithBinary = vi
      .spyOn(manager, "_startWithBinary")
      .mockImplementation(async (serverBinary: string) => {
        if (serverBinary === cudaPath) {
          throw Object.assign(new Error("spawn UNKNOWN"), {
            code: "UNKNOWN",
            syscall: "spawn whisper-server-win32-x64-cuda.exe",
          });
        }
      });

    vi.spyOn(manager, "getServerBinaryPath").mockReturnValue(cudaPath);
    vi.spyOn(manager, "getCpuServerBinaryPath").mockReturnValue(cpuPath);

    await expect(manager._doStart(modelPath)).resolves.toBeUndefined();

    expect(startWithBinary).toHaveBeenCalledTimes(2);
    expect(startWithBinary).toHaveBeenNthCalledWith(1, cudaPath, modelPath, {});
    expect(startWithBinary).toHaveBeenNthCalledWith(2, cpuPath, modelPath, {});
    expect(manager.cudaDisabledForSession).toBe(true);
    expect(manager.cachedServerBinaryPath).toBe(cpuPath);
  });

  it("stops a running CUDA server when CPU mode is selected", async () => {
    const manager = new WhisperServerManager();
    const stop = vi.spyOn(manager, "stop").mockResolvedValue(undefined);

    manager.forceCpu = true;
    manager.process = {};
    manager.activeServerBinaryPath =
      "C:\\PrivateTranscribe\\bin\\whisper-server-win32-x64-cuda.exe";
    manager.cachedServerBinaryPath = manager.activeServerBinaryPath;

    await manager.setForceCpu(true);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(manager.cachedServerBinaryPath).toBeNull();
  });

  it("does not stop the fallback CPU server on every GPU-mode request after CUDA failed", async () => {
    const manager = new WhisperServerManager();
    const stop = vi.spyOn(manager, "stop").mockResolvedValue(undefined);

    manager.forceCpu = false;
    manager.cudaDisabledForSession = true;
    manager.process = {};
    manager.activeServerBinaryPath = "C:\\PrivateTranscribe\\bin\\whisper-server-win32-x64.exe";
    manager.cachedServerBinaryPath = manager.activeServerBinaryPath;

    await manager.setForceCpu(false);

    expect(stop).not.toHaveBeenCalled();
    expect(manager.cudaDisabledForSession).toBe(true);
    expect(manager.cachedServerBinaryPath).toBe(manager.activeServerBinaryPath);
  });

  it("retries CUDA when the user explicitly switches from CPU mode to GPU mode", async () => {
    const manager = new WhisperServerManager();
    const stop = vi.spyOn(manager, "stop").mockResolvedValue(undefined);

    manager.forceCpu = true;
    manager.cudaDisabledForSession = true;
    manager.process = {};
    manager.activeServerBinaryPath = "C:\\PrivateTranscribe\\bin\\whisper-server-win32-x64.exe";
    manager.cachedServerBinaryPath = manager.activeServerBinaryPath;

    await manager.setForceCpu(false);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(manager.cudaDisabledForSession).toBe(false);
    expect(manager.cachedServerBinaryPath).toBeNull();
  });

  it("does not idle-stop while a transcription is active", async () => {
    const manager = new WhisperServerManager();
    const stop = vi.spyOn(manager, "stop").mockResolvedValue(undefined);

    manager.process = {};
    manager.ready = true;
    manager.activeTranscriptions = 1;
    manager.lastUsedTime = Date.now() - 60_000;
    manager.idleTimeoutMs = 1;

    await expect(manager.checkIdleAndStop()).resolves.toBe(false);

    expect(stop).not.toHaveBeenCalled();
    expect(manager.stoppedDueToIdle).toBe(false);
  });

  describe("automatic CUDA retry after startup failure", () => {
    const cudaPath = "C:\\bin\\whisper-server-win32-x64-cuda.exe";
    const cpuPath = "C:\\bin\\whisper-server-win32-x64.exe";

    it("escalates the retry backoff with the failure count", () => {
      const manager = new WhisperServerManager();

      manager._cudaFailureCount = 1;
      expect(manager.getCudaRetryDelayMs()).toBe(60 * 1000);
      manager._cudaFailureCount = 2;
      expect(manager.getCudaRetryDelayMs()).toBe(5 * 60 * 1000);
      manager._cudaFailureCount = 3;
      expect(manager.getCudaRetryDelayMs()).toBe(30 * 60 * 1000);
      manager._cudaFailureCount = 10;
      expect(manager.getCudaRetryDelayMs()).toBe(30 * 60 * 1000);
    });

    it("keeps the CPU binary inside the backoff window and retries CUDA after it", () => {
      vi.useFakeTimers();
      const manager = new WhisperServerManager();
      vi.spyOn(GpuBinaryManager.prototype, "getCudaBinaryPath").mockReturnValue(cudaPath);
      vi.spyOn(manager, "getCpuServerBinaryPath").mockReturnValue(cpuPath);

      manager.cudaDisabledForSession = true;
      manager._cudaDisabledAt = Date.now();
      manager._cudaFailureCount = 1;
      manager.cachedServerBinaryPath = cpuPath;

      expect(manager.getServerBinaryPath()).toBe(cpuPath);

      vi.advanceTimersByTime(59 * 1000);
      expect(manager.getServerBinaryPath()).toBe(cpuPath);

      vi.advanceTimersByTime(2 * 1000);
      expect(manager.getServerBinaryPath()).toBe(cudaPath);
    });

    it("counts repeated CUDA startup failures and re-arms the backoff", async () => {
      tempDir = mkdtempSync(path.join(tmpdir(), "pt-whisper-"));
      const modelPath = path.join(tempDir, "ggml-test.bin");
      writeFileSync(modelPath, "model");

      const manager = new WhisperServerManager();
      vi.spyOn(manager, "_startWithBinary").mockImplementation(
        async (serverBinary: string) => {
          if (serverBinary === cudaPath) {
            throw Object.assign(new Error("whisper-server process died during startup"), {
              exitCode: 1,
            });
          }
        }
      );
      vi.spyOn(manager, "getServerBinaryPath").mockReturnValue(cudaPath);
      vi.spyOn(manager, "getCpuServerBinaryPath").mockReturnValue(cpuPath);

      await manager._doStart(modelPath);
      expect(manager._cudaFailureCount).toBe(1);
      expect(manager.getNextCudaRetryAt()).toBe(manager._cudaDisabledAt + 60 * 1000);

      await manager._doStart(modelPath);
      expect(manager._cudaFailureCount).toBe(2);
      expect(manager.getNextCudaRetryAt()).toBe(manager._cudaDisabledAt + 5 * 60 * 1000);
    });

    it("clears the fallback state when a CUDA start succeeds again", async () => {
      tempDir = mkdtempSync(path.join(tmpdir(), "pt-whisper-"));
      const modelPath = path.join(tempDir, "ggml-test.bin");
      writeFileSync(modelPath, "model");

      const manager = new WhisperServerManager();
      vi.spyOn(manager, "_startWithBinary").mockResolvedValue(undefined);
      vi.spyOn(manager, "getServerBinaryPath").mockReturnValue(cudaPath);

      manager.cudaDisabledForSession = true;
      manager._cudaDisabledAt = Date.now() - 60 * 60 * 1000;
      manager._cudaFailureCount = 2;
      manager._lastCudaStartupFailure = { kind: "startup_failure" };

      await manager._doStart(modelPath);

      expect(manager.cudaDisabledForSession).toBe(false);
      expect(manager._cudaDisabledAt).toBeNull();
      expect(manager._cudaFailureCount).toBe(0);
      expect(manager._lastCudaStartupFailure).toBeNull();
    });

    it("restarts a warm CPU-fallback server when the CUDA retry window has elapsed", async () => {
      const manager = new WhisperServerManager();
      vi.spyOn(GpuBinaryManager.prototype, "getCudaBinaryPath").mockReturnValue(cudaPath);

      manager.forceCpu = false;
      manager.cudaDisabledForSession = true;
      manager._cudaDisabledAt = Date.now() - 60 * 60 * 1000;
      manager._cudaFailureCount = 1;
      manager.ready = true;
      manager.process = { pid: 1234 };
      manager.modelPath = "/tmp/ggml-base.bin";
      manager.loadedModelPath = "/tmp/ggml-base.bin";
      manager.printRealtimeEnabled = false;

      const stop = vi.spyOn(manager, "stop").mockImplementation(async () => {
        manager.ready = false;
        manager.process = null;
        manager.loadedModelPath = null;
      });
      const doStart = vi.spyOn(manager, "_doStart").mockImplementation(async () => {
        manager.ready = true;
        manager.process = { pid: 5678 };
        manager.loadedModelPath = "/tmp/ggml-base.bin";
      });

      manager.activeServerBinaryPath = cpuPath;
      await manager.start("/tmp/ggml-base.bin");

      expect(stop).toHaveBeenCalledTimes(1);
      expect(doStart).toHaveBeenCalledTimes(1);
    });

    it("does not restart a warm CPU-fallback server before the retry window", async () => {
      const manager = new WhisperServerManager();
      vi.spyOn(GpuBinaryManager.prototype, "getCudaBinaryPath").mockReturnValue(cudaPath);

      manager.forceCpu = false;
      manager.cudaDisabledForSession = true;
      manager._cudaDisabledAt = Date.now();
      manager._cudaFailureCount = 1;
      manager.ready = true;
      manager.process = { pid: 1234 };
      manager.modelPath = "/tmp/ggml-base.bin";
      manager.loadedModelPath = "/tmp/ggml-base.bin";
      manager.printRealtimeEnabled = false;
      manager.activeServerBinaryPath = cpuPath;

      const stop = vi.spyOn(manager, "stop").mockResolvedValue(undefined);
      const doStart = vi.spyOn(manager, "_doStart").mockResolvedValue(undefined);

      await manager.start("/tmp/ggml-base.bin");

      expect(stop).not.toHaveBeenCalled();
      expect(doStart).not.toHaveBeenCalled();
    });
  });

  describe("engine fallback notifications", () => {
    const cudaPath = "C:\\bin\\whisper-server-win32-x64-cuda.exe";
    const cpuPath = "C:\\bin\\whisper-server-win32-x64.exe";

    it("notifies when the CPU fallback engages and when CUDA recovers", async () => {
      tempDir = mkdtempSync(path.join(tmpdir(), "pt-whisper-"));
      const modelPath = path.join(tempDir, "ggml-test.bin");
      writeFileSync(modelPath, "model");

      const manager = new WhisperServerManager();
      const events: Array<{ active?: boolean; recovered?: boolean }> = [];
      manager.onEngineFallbackChanged = (payload: { active?: boolean; recovered?: boolean }) =>
        events.push(payload);

      let cudaFails = true;
      vi.spyOn(manager, "_startWithBinary").mockImplementation(
        async (serverBinary: string) => {
          if (serverBinary === cudaPath && cudaFails) {
            throw Object.assign(new Error("whisper-server process died during startup"), {
              exitCode: 1,
            });
          }
        }
      );
      vi.spyOn(manager, "getServerBinaryPath").mockReturnValue(cudaPath);
      vi.spyOn(manager, "getCpuServerBinaryPath").mockReturnValue(cpuPath);

      await manager._doStart(modelPath);
      expect(events).toHaveLength(1);
      expect(events[0].active).toBe(true);
      expect(events[0]).toMatchObject({
        reason: "cuda_startup_failure",
        failureCount: 1,
      });

      cudaFails = false;
      await manager._doStart(modelPath);
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({ active: false, recovered: true });
    });

    it("does not throw when the listener itself throws", async () => {
      tempDir = mkdtempSync(path.join(tmpdir(), "pt-whisper-"));
      const modelPath = path.join(tempDir, "ggml-test.bin");
      writeFileSync(modelPath, "model");

      const manager = new WhisperServerManager();
      manager.onEngineFallbackChanged = () => {
        throw new Error("listener boom");
      };
      vi.spyOn(manager, "_startWithBinary").mockImplementation(
        async (serverBinary: string) => {
          if (serverBinary === cudaPath) {
            throw Object.assign(new Error("whisper-server process died during startup"), {
              exitCode: 1,
            });
          }
        }
      );
      vi.spyOn(manager, "getServerBinaryPath").mockReturnValue(cudaPath);
      vi.spyOn(manager, "getCpuServerBinaryPath").mockReturnValue(cpuPath);

      await expect(manager._doStart(modelPath)).resolves.toBeUndefined();
    });
  });

  describe("getEngineStatus", () => {
    it("reports CPU fallback when CUDA failed and user wants GPU", () => {
      const manager = new WhisperServerManager();
      manager.forceCpu = false;
      manager.cudaDisabledForSession = true;
      manager._cudaDisabledAt = 12345;
      manager.ready = true;
      manager.activeServerBinaryPath = "/fake/whisper-server-win32-x64.exe";

      const status = manager.getEngineStatus();
      expect(status.desiredMode).toBe("gpu");
      expect(status.effectiveEngine).toBe("cpu");
      expect(status.fallback.active).toBe(true);
      expect(status.fallback.reason).toBe("cuda_startup_failure");
      expect(status.fallback.since).toBe(12345);
    });

    it("reports CUDA active when GPU mode is working", () => {
      const manager = new WhisperServerManager();
      manager.forceCpu = false;
      manager.cudaDisabledForSession = false;
      manager.ready = true;
      manager.activeServerBinaryPath = "/fake/whisper-server-win32-x64-cuda.exe";

      const status = manager.getEngineStatus();
      expect(status.desiredMode).toBe("gpu");
      expect(status.effectiveEngine).toBe("cuda");
      expect(status.fallback.active).toBe(false);
      expect(status.transition).toBe("idle");
    });

    it("reports correct transition states", () => {
      const manager = new WhisperServerManager();
      manager.ready = true;
      manager.activeServerBinaryPath = "/fake/whisper-server-win32-x64.exe";

      // Idle
      expect(manager.getEngineStatus().transition).toBe("idle");

      // Transcribing
      manager.activeTranscriptions = 1;
      expect(manager.getEngineStatus().transition).toBe("transcribing");

      // Starting
      manager.activeTranscriptions = 0;
      manager.startupPromise = Promise.resolve();
      expect(manager.getEngineStatus().transition).toBe("starting");
      manager.startupPromise = null;

      // Stopped
      manager.ready = false;
      manager.activeServerBinaryPath = null;
      expect(manager.getEngineStatus().transition).toBe("stopped");
    });

    it("reports CPU mode correctly", () => {
      const manager = new WhisperServerManager();
      manager.forceCpu = true;
      manager.ready = true;
      manager.activeServerBinaryPath = "/fake/whisper-server-win32-x64.exe";

      const status = manager.getEngineStatus();
      expect(status.desiredMode).toBe("cpu");
      expect(status.effectiveEngine).toBe("cpu");
      expect(status.fallback.active).toBe(false);
    });
  });
});
