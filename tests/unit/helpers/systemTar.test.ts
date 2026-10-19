import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The Parakeet and diarization downloads extract .tar.bz2 archives to C:\ paths.
 * Git for Windows' GNU tar, when first on PATH, reads "C:" as a remote host, so
 * Windows must always get its own bsdtar.
 */

const { getTarCommand, getTarExtractSpawn } = require("../../../src/helpers/systemTar");
const ParakeetManager = require("../../../src/helpers/parakeet");
const { DiarizationManager } = require("../../../src/helpers/diarizationManager");

describe("getTarCommand", () => {
  it("uses System32 tar on Windows", () => {
    expect(getTarCommand("win32", { SystemRoot: "C:\\Windows" })).toBe(
      "C:\\Windows\\System32\\tar.exe"
    );
  });

  it("follows a Windows install on another drive", () => {
    expect(getTarCommand("win32", { SystemRoot: "D:\\WINDOWS" })).toBe(
      "D:\\WINDOWS\\System32\\tar.exe"
    );
  });

  it("falls back to C:\\Windows when SystemRoot is unset", () => {
    expect(getTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("uses tar from PATH elsewhere", () => {
    expect(getTarCommand("linux", {})).toBe("tar");
    expect(getTarCommand("darwin", {})).toBe("tar");
  });
});

/**
 * tar.exe reads its arguments in the ANSI code page, so an archive under
 * C:\Users\Ωmega reached it as "Omega" and one under C:\Users\李雷 as "??", and the
 * model download failed. Such paths now go into the working directory.
 */
describe("getTarExtractSpawn", () => {
  const win = { platform: "win32", env: { SystemRoot: "C:\\Windows" } };

  it("passes ASCII paths unchanged", () => {
    const models = "C:\\Users\\KT\\.cache\\PrivateTranscribe\\parakeet-models";
    expect(
      getTarExtractSpawn(`${models}\\model.tar.bz2`, `${models}\\temp-extract-model`, win)
    ).toEqual({
      command: "C:\\Windows\\System32\\tar.exe",
      args: ["-xjf", `${models}\\model.tar.bz2`, "-C", `${models}\\temp-extract-model`],
      cwd: null,
    });
  });

  it("starts a Parakeet extract in Ωmega's models folder", () => {
    const models = "C:\\Users\\Ωmega\\.cache\\PrivateTranscribe\\parakeet-models";
    expect(
      getTarExtractSpawn(
        `${models}\\parakeet-tdt-0.6b-v3.tar.bz2`,
        `${models}\\temp-extract-parakeet-tdt-0.6b-v3`,
        win
      )
    ).toEqual({
      command: "C:\\Windows\\System32\\tar.exe",
      args: ["-xjf", "parakeet-tdt-0.6b-v3.tar.bz2", "-C", "temp-extract-parakeet-tdt-0.6b-v3"],
      cwd: models,
    });
  });

  it("starts a diarization extract one level above 李雷's models folder", () => {
    const cache = "C:\\Users\\李雷\\.cache\\PrivateTranscribe";
    const spawn = getTarExtractSpawn(
      `${cache}\\diarization-models\\sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`,
      `${cache}\\diarization-models`,
      win
    );
    expect(spawn.args).toEqual([
      "-xjf",
      "diarization-models\\sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
      "-C",
      "diarization-models",
    ]);
    expect(spawn.cwd).toBe(cache);
  });

  it("leaves paths alone off Windows", () => {
    const spawn = getTarExtractSpawn("/home/Ωmega/model.tar.bz2", "/home/Ωmega/out", {
      platform: "linux",
      env: {},
    });
    expect(spawn).toEqual({
      command: "tar",
      args: ["-xjf", "/home/Ωmega/model.tar.bz2", "-C", "/home/Ωmega/out"],
      cwd: null,
    });
  });
});

// The real tar.exe, through both download paths, on folders outside the ANSI code page.
describe.runIf(process.platform === "win32")("real tar.exe under non-ASCII user folders", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pt-tar-"));
  const source = path.join(root, "source");

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A .tar.bz2 holding model-dir/tokens.txt, built with relative names so any TEMP works. */
  function buildArchive() {
    const archive = path.join(source, "model.tar.bz2");
    if (fs.existsSync(archive)) return archive;
    fs.mkdirSync(path.join(source, "model-dir"), { recursive: true });
    fs.writeFileSync(path.join(source, "model-dir", "tokens.txt"), "tokens");
    const result = spawnSync(getTarCommand(), ["-cjf", "model.tar.bz2", "model-dir"], {
      cwd: source,
      windowsHide: true,
    });
    expect(result.status).toBe(0);
    return archive;
  }

  function cacheFolder(name: string, service: string) {
    const dir = path.join(root, "Users", name, ".cache", "PrivateTranscribe", service);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it.each(["Søren", "Ωmega", "李雷"])("extracts a Parakeet model under %s", async (name) => {
    const models = cacheFolder(name, "parakeet-models");
    const archive = path.join(models, "parakeet-test.tar.bz2");
    fs.copyFileSync(buildArchive(), archive);
    const extractDir = path.join(models, "temp-extract-parakeet-test");
    fs.mkdirSync(extractDir);

    await new ParakeetManager()._runTarExtract(archive, extractDir);

    expect(fs.readFileSync(path.join(extractDir, "model-dir", "tokens.txt"), "utf8")).toBe(
      "tokens"
    );
  });

  it.each(["Søren", "Ωmega", "李雷"])("extracts the diarization model under %s", async (name) => {
    const models = cacheFolder(name, "diarization-models");
    const archive = path.join(models, "sherpa-onnx-pyannote-segmentation-3-0.tar.bz2");
    fs.copyFileSync(buildArchive(), archive);

    await new DiarizationManager({ modelsDir: models }).extractTarBz2(archive, models);

    expect(fs.readFileSync(path.join(models, "model-dir", "tokens.txt"), "utf8")).toBe("tokens");
  });
});
