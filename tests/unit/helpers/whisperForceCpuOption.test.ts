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

describe("WhisperManager forceCpu option", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("applies per-transcription CPU/GPU preference before choosing a server binary", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "pt-whisper-force-cpu-"));
    const modelPath = path.join(tempDir, "ggml-turbo.bin");
    writeFileSync(modelPath, "model");

    const manager = new WhisperManager();
    manager.getModelPath = vi.fn(() => modelPath);
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
      forceCpu: true,
    });

    expect(manager.serverManager.setForceCpu).toHaveBeenCalledWith(true);
    expect(manager.serverManager.isAvailable).toHaveBeenCalled();
    expect(manager.serverManager.transcribe).toHaveBeenCalled();
  });
});
