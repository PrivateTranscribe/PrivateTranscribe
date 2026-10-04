/**
 * Every runtime download hands its pinned SHA-256 to downloadFile, which checks
 * it before the file is used. downloadFile is swapped for a recorder before the
 * managers load, because they destructure it at require time.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir(), isReady: () => false },
}));

type DownloadCall = { url: string; destPath: string; options: { sha256?: string | null } };

const SHA256 = /^[a-f0-9]{64}$/;
const calls: DownloadCall[] = [];
let failWith: Error | null = null;

const downloadUtils = require("../../../src/helpers/downloadUtils");
const realDownloadFile = downloadUtils.downloadFile;
downloadUtils.downloadFile = async (url: string, destPath: string, options = {}) => {
  calls.push({ url, destPath, options });
  if (failWith) throw failWith;
};

const MANAGER_MODULES = [
  "whisper",
  "parakeet",
  "kokoro",
  "diarizationManager",
  "modelManagerBridge",
  "gpuBinaryManager",
].map((name) => require.resolve(`../../../src/helpers/${name}`));
for (const modulePath of MANAGER_MODULES) delete require.cache[modulePath];

const WhisperManager = require("../../../src/helpers/whisper");
const ParakeetManager = require("../../../src/helpers/parakeet");
const KokoroManager = require("../../../src/helpers/kokoro");
const diarization = require("../../../src/helpers/diarizationManager");
const { default: modelManager } = require("../../../src/helpers/modelManagerBridge");
const GpuBinaryManager = require("../../../src/helpers/gpuBinaryManager");
const registry = require("../../../src/models/modelRegistryData.json");

/** Ends a download flow right after the call was recorded. */
const STOP = Object.assign(new Error("stopped by test"), { isHttpError: true, statusCode: 599 });

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-pin-wiring-"));
  calls.length = 0;
  failWith = STOP;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
  downloadUtils.downloadFile = realDownloadFile;
  for (const modulePath of MANAGER_MODULES) delete require.cache[modulePath];
});

describe("pinned SHA-256 reaches every runtime download", () => {
  it("Whisper models", async () => {
    const manager = new WhisperManager();
    manager.getModelsDir = () => tmpDir;
    const model = registry.whisperModels.base;

    await expect(manager.downloadWhisperModel("base")).rejects.toBe(STOP);

    expect(calls).toEqual([
      {
        url: model.downloadUrl,
        destPath: path.join(tmpDir, model.fileName),
        options: expect.objectContaining({ sha256: model.sha256 }),
      },
    ]);
  });

  it("the Parakeet model archive", async () => {
    const manager = new ParakeetManager();
    manager.getModelsDir = () => tmpDir;
    manager.serverManager = { isModelDownloaded: () => false };
    const model = registry.parakeetModels["parakeet-tdt-0.6b-v3"];

    await expect(manager.downloadParakeetModel("parakeet-tdt-0.6b-v3")).rejects.toBe(STOP);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: model.downloadUrl, options: { sha256: model.sha256 } });
  });

  it("each Kokoro (Read Aloud) file", async () => {
    const manager = new KokoroManager();
    manager.getModelsDir = () => tmpDir;
    failWith = null; // let every file "finish" so all of them are requested
    const { files } = registry.kokoroModels["kokoro-82m-v1.0-fp32"];

    await expect(manager.downloadKokoroModel()).rejects.toMatchObject({
      code: "download-incomplete",
    });

    expect(calls.map((call) => [call.url, call.options.sha256])).toEqual(
      files.map((file: { url: string; sha256: string }) => [file.url, file.sha256])
    );
  });

  it("both diarization models", async () => {
    const manager = new diarization.DiarizationManager({ modelsDir: tmpDir });
    manager.extractTarBz2 = async () => {};
    failWith = null;

    await expect(manager.downloadModels()).rejects.toThrow(/still missing/);

    expect(diarization.SEGMENTATION_ARCHIVE_SHA256).toMatch(SHA256);
    expect(diarization.EMBEDDING_MODEL_SHA256).toMatch(SHA256);
    expect(calls.map((call) => [call.url, call.options.sha256])).toEqual([
      [diarization.SEGMENTATION_ARCHIVE_URL, diarization.SEGMENTATION_ARCHIVE_SHA256],
      [diarization.EMBEDDING_MODEL_URL, diarization.EMBEDDING_MODEL_SHA256],
    ]);
  });

  describe("local AI models", () => {
    const model = registry.localProviders
      .flatMap((provider: { models: unknown[] }) => provider.models)
      .find((entry: { id: string }) => entry.id === "qwen3-0.6b-q8_0");

    beforeEach(() => {
      modelManager._initialized = true;
      modelManager.modelsDir = tmpDir;
    });

    it("download from the pinned commit with the pinned hash", async () => {
      await expect(modelManager.downloadModel(model.id)).rejects.toMatchObject({
        code: "DOWNLOAD_FAILED",
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        url: `https://huggingface.co/${model.hfRepo}/resolve/${model.hfRevision}/${model.fileName}`,
        options: { sha256: model.sha256 },
      });
    });

    it("report a mismatch with the existing corrupted-download error", async () => {
      failWith = Object.assign(new Error("Downloaded file does not match its pinned SHA-256"), {
        code: "CHECKSUM_MISMATCH",
        expectedSha256: "a".repeat(64),
        actualSha256: "b".repeat(64),
      });

      await expect(modelManager.downloadModel(model.id)).rejects.toMatchObject({
        code: "DOWNLOAD_CORRUPTED",
        message: "Downloaded model checksum does not match the expected artifact",
        details: { expectedSha256: "a".repeat(64), actualSha256: "b".repeat(64) },
      });
    });
  });

  it("the CUDA engine package", async () => {
    const manager = new GpuBinaryManager();
    manager.getBinDir = () => tmpDir;
    const spec = GpuBinaryManager.CUDA_BINARIES["win32-x64"];

    const result = await manager._runCudaDownload(spec);

    expect(result).toEqual({ success: false, error: STOP.message });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: spec.remoteUrl, options: { sha256: spec.sha256 } });
    for (const pinned of Object.values(GpuBinaryManager.CUDA_BINARIES) as Array<{
      sha256: string | null;
    }>) {
      // null only while the published engine has no recorded hash
      expect(pinned.sha256 === null || SHA256.test(pinned.sha256)).toBe(true);
    }
  });
});
