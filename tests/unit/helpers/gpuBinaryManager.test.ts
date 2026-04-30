import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => tmpdir(),
    isReady: () => false,
  },
}));

const GpuBinaryManager = require("../../../src/helpers/gpuBinaryManager");

describe("GpuBinaryManager CUDA package install", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("extracts the CUDA server binary and companion runtime libraries from a zip package", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "pt-cuda-package-"));
    const packageDir = path.join(tempDir, "package");
    const binDir = path.join(tempDir, "bin");
    mkdirSync(packageDir);
    mkdirSync(binDir);

    writeFileSync(path.join(packageDir, "whisper-server-win32-x64-cuda.exe"), "fake exe");
    writeFileSync(path.join(packageDir, "cudart64_12.dll"), "fake cudart");
    writeFileSync(path.join(packageDir, "cublas64_12.dll"), "fake cublas");
    writeFileSync(path.join(packageDir, "cublasLt64_12.dll"), "fake cublasLt");

    const archivePath = path.join(tempDir, "whisper-server-win32-x64-cuda.zip");
    execFileSync("zip", ["-q", "-r", archivePath, "."], { cwd: packageDir });

    const manager = new GpuBinaryManager();
    const result = await manager.installCudaPackage(
      archivePath,
      {
        outputName: "whisper-server-win32-x64-cuda.exe",
        companionPattern: /\.dll$/i,
      },
      binDir
    );

    expect(result.binaryPath).toBe(path.join(binDir, "whisper-server-win32-x64-cuda.exe"));
    expect(result.companionCount).toBe(3);
    expect(existsSync(path.join(binDir, "whisper-server-win32-x64-cuda.exe"))).toBe(true);
    expect(existsSync(path.join(binDir, "cudart64_12.dll"))).toBe(true);
    expect(existsSync(path.join(binDir, "cublas64_12.dll"))).toBe(true);
    expect(existsSync(path.join(binDir, "cublasLt64_12.dll"))).toBe(true);
  });
});
