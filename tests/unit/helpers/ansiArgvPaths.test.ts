import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * whisper-server and System32's tar.exe read their command line in the ANSI
 * code page, so a user folder such as C:\Users\Søren reaches them mangled.
 * planAnsiArgvPaths moves the non-ASCII part into the working directory.
 */

const { isAsciiPath, planAnsiArgvPaths } = require("../../../src/helpers/ansiArgvPaths");

const win32 = { platform: "win32" };
const SOREN_MODELS = "C:\\Users\\Søren\\.cache\\PrivateTranscribe\\whisper-models";
const OMEGA_CACHE = "C:\\Users\\Ωmega\\.cache\\PrivateTranscribe";

describe("isAsciiPath", () => {
  it("accepts printable ASCII, spaces included", () => {
    expect(isAsciiPath("C:\\Users\\John Smith\\ggml-base.bin")).toBe(true);
  });

  it("rejects letters a narrow main() cannot carry", () => {
    expect(isAsciiPath("C:\\Users\\Søren")).toBe(false);
    expect(isAsciiPath("C:\\Users\\Ωmega")).toBe(false);
    expect(isAsciiPath("C:\\Users\\李雷")).toBe(false);
  });
});

describe("planAnsiArgvPaths", () => {
  it("leaves ASCII paths and the caller's working directory alone", () => {
    const model = "C:\\Users\\KT\\.cache\\PrivateTranscribe\\whisper-models\\ggml-base.bin";
    expect(planAnsiArgvPaths([model], win32)).toEqual({ cwd: null, paths: [model] });
  });

  it("starts in a Søren model folder and passes the bare file name", () => {
    expect(planAnsiArgvPaths([`${SOREN_MODELS}\\ggml-base.bin`], win32)).toEqual({
      cwd: SOREN_MODELS,
      paths: ["ggml-base.bin"],
    });
  });

  it("uses the folder an archive and its extract folder share", () => {
    const models = `${OMEGA_CACHE}\\parakeet-models`;
    expect(
      planAnsiArgvPaths(
        [`${models}\\parakeet-tdt-0.6b-v3.tar.bz2`, `${models}\\temp-extract-parakeet-tdt-0.6b-v3`],
        win32
      )
    ).toEqual({
      cwd: models,
      paths: ["parakeet-tdt-0.6b-v3.tar.bz2", "temp-extract-parakeet-tdt-0.6b-v3"],
    });
  });

  it("climbs one level when the destination is the archive's own folder", () => {
    const models = `${OMEGA_CACHE}\\diarization-models`;
    expect(
      planAnsiArgvPaths([`${models}\\sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`, models], win32)
    ).toEqual({
      cwd: OMEGA_CACHE,
      paths: [
        "diarization-models\\sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
        "diarization-models",
      ],
    });
  });

  it("keeps the old paths when no ASCII relative form exists", () => {
    // The file name itself is outside ASCII, so a relative name would be mangled too.
    const model = "C:\\Users\\Søren\\Ωmega.bin";
    expect(planAnsiArgvPaths([model], win32)).toEqual({ cwd: null, paths: [model] });
    // Two drives share no folder.
    const across = ["C:\\Users\\Søren\\a.tar.bz2", "D:\\extract"];
    expect(planAnsiArgvPaths(across, win32)).toEqual({ cwd: null, paths: across });
  });

  it("changes nothing off Windows, where argv is UTF-8", () => {
    const model = "/home/søren/.cache/PrivateTranscribe/whisper-models/ggml-base.bin";
    expect(planAnsiArgvPaths([model], { platform: "linux" })).toEqual({
      cwd: null,
      paths: [model],
    });
  });
});

describe.runIf(process.platform === "win32")("planAnsiArgvPaths on real folders", () => {
  // Made in beforeAll: Vitest runs a skipped describe's body but not its afterAll.
  let root = "";

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pt-ansi-argv-"));
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(["Søren", "Ωmega", "李雷"])("resolves to the same file under %s", (name) => {
    const folder = path.join(root, name, "whisper-models");
    fs.mkdirSync(folder, { recursive: true });
    const model = path.join(folder, "ggml-base.bin");
    fs.writeFileSync(model, "model");

    const plan = planAnsiArgvPaths([model]);

    expect(plan.cwd).toBe(folder);
    expect(plan.paths).toEqual(["ggml-base.bin"]);
    expect(fs.readFileSync(path.resolve(plan.cwd, plan.paths[0]), "utf8")).toBe("model");
  });
});
