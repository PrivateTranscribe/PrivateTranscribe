import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("modelDirUtils", () => {
  let tmpDir: string;
  let getModelsDirForService: (service: string) => string;
  let migrateModelDirIfNeeded: () => Promise<void>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-model-dir-"));
    vi.resetModules();
    vi.spyOn(os, "homedir").mockReturnValue(tmpDir);

    ({
      getModelsDirForService,
      migrateModelDirIfNeeded,
    } = require("../../../src/helpers/modelDirUtils"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("resolves service models under the PrivateTranscribe cache", () => {
    expect(getModelsDirForService("whisper")).toBe(
      path.join(tmpDir, ".cache", "PrivateTranscribe", "whisper-models")
    );
  });

  it("migrates missing legacy service folders even when the new cache already exists", async () => {
    const oldBase = path.join(tmpDir, ".cache", "Privoca");
    const newBase = path.join(tmpDir, ".cache", "PrivateTranscribe");
    const oldWhisper = path.join(oldBase, "whisper-models");
    const oldLlama = path.join(oldBase, "llama-models");
    const newWhisper = path.join(newBase, "whisper-models");

    fs.mkdirSync(oldWhisper, { recursive: true });
    fs.mkdirSync(oldLlama, { recursive: true });
    fs.mkdirSync(newWhisper, { recursive: true });
    fs.writeFileSync(path.join(oldWhisper, "legacy.bin"), "old whisper");
    fs.writeFileSync(path.join(newWhisper, "current.bin"), "new whisper");
    fs.writeFileSync(path.join(oldLlama, "model.gguf"), "llama");

    await migrateModelDirIfNeeded();

    expect(fs.readFileSync(path.join(newWhisper, "current.bin"), "utf8")).toBe("new whisper");
    expect(fs.existsSync(path.join(newWhisper, "legacy.bin"))).toBe(false);
    expect(fs.readFileSync(path.join(newBase, "llama-models", "model.gguf"), "utf8")).toBe("llama");
    expect(fs.existsSync(oldWhisper)).toBe(true);
    expect(fs.existsSync(oldLlama)).toBe(false);
  });
});
