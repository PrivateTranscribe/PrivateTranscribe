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

describe("WhisperServerManager CUDA startup fallback", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
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
});
