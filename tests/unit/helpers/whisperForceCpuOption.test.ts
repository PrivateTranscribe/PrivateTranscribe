import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => tmpdir(),
    isReady: () => false,
  },
}));

const WhisperManager = require("../../../src/helpers/whisper");

describe("WhisperManager engine mode", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("does NOT mutate engine mode from transcribe options", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "pt-whisper-engine-"));
    const modelPath = path.join(tempDir, "ggml-turbo.bin");
    writeFileSync(modelPath, "model");

    const manager = new WhisperManager();
    manager.getModelPath = vi.fn(() => modelPath);
    // The real model-validity guard rejects our tiny fake .bin; this test only
    // cares about the engine-mode path, so report the model as valid.
    manager.getModelFileStatus = vi.fn(() => ({
      modelPath,
      exists: true,
      valid: true,
      size: 2_000_000_000,
    }));
    manager.serverManager = {
      forceCpu: false,
      activeServerBinaryPath: path.join(tempDir, "whisper-server-win32-x64-cuda.exe"),
      isAvailable: vi.fn(() => true),
      ready: true,
      stoppedDueToIdle: false,
      port: 8178,
      setForceCpu: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      transcribe: vi.fn(async () => ({ success: true, text: "hello" })),
      checkIdleAndStop: vi.fn(async () => {}),
    };

    await manager.transcribeLocalWhisper(Buffer.from("audio"), {
      model: "turbo",
      forceCpu: true, // Should be ignored — engine mode changes go through IPC only
    });

    // setForceCpu must NOT be called from the transcribe path
    expect(manager.serverManager.setForceCpu).not.toHaveBeenCalled();
    expect(manager.serverManager.isAvailable).toHaveBeenCalled();
    expect(manager.serverManager.transcribe).toHaveBeenCalled();
  });

  it("delegates getEngineStatus to serverManager", () => {
    const manager = new WhisperManager();
    const mockStatus = { desiredMode: "gpu", effectiveEngine: "cuda", fallback: { active: false } };
    manager.serverManager = {
      getEngineStatus: vi.fn(() => mockStatus),
      getStatus: vi.fn(() => ({})),
    };

    const result = manager.getEngineStatus();
    expect(manager.serverManager.getEngineStatus).toHaveBeenCalled();
    expect(result).toEqual(mockStatus);
  });

  it("reports outdated CUDA engines as installed but not up to date", () => {
    const manager = new WhisperManager();
    manager.gpuBinaryManager = {
      getPlatformKey: vi.fn(() => "win32-x64"),
      getCudaBinaryFilePath: vi.fn(() => "C:\\PrivateTranscribe\\whisper-server-win32-x64-cuda.exe"),
      getCudaBinaryVersion: vi.fn(() => "v0.0.7"),
      isCudaBinaryUpToDate: vi.fn(() => false),
      getExpectedCudaBinaryVersion: vi.fn(() => "v0.0.8"),
    };
    manager.serverManager = {
      forceCpu: false,
      getEngineStatus: vi.fn(() => ({ effectiveEngine: "stopped" })),
    };

    const status = manager.getCudaBinaryStatus();

    expect(status.installed).toBe(true);
    expect(status.upToDate).toBe(false);
    expect(status.version).toBe("v0.0.7");
    expect(status.expectedVersion).toBe("v0.0.8");
  });

  it("does not pre-warm whisper-server during startup initialization", async () => {
    const manager = new WhisperManager();
    manager.serverManager = {
      ready: false,
      setIdleTimeoutMs: vi.fn(),
      setForceCpu: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      isAvailable: vi.fn(() => true),
      getServerBinaryPath: vi.fn(() => null),
      getStatus: vi.fn(() => ({})),
      getEngineStatus: vi.fn(() => ({})),
      port: 8178,
    };
    manager.logDependencyStatus = vi.fn(async () => {});

    await manager.initializeAtStartup({
      localTranscriptionProvider: "whisper",
      whisperModel: "turbo",
      whisperServerIdleTimeoutMinutes: 3,
      whisperForceCpu: true,
    });

    expect(manager.serverManager.setIdleTimeoutMs).toHaveBeenCalledWith(3 * 60 * 1000);
    expect(manager.serverManager.setForceCpu).toHaveBeenCalledWith(true);
    expect(manager.serverManager.start).not.toHaveBeenCalled();
  });
});
