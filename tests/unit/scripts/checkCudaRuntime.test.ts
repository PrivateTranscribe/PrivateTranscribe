import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const { findCudaRuntimeProblems } = require("../../../scripts/check-cuda-runtime");

// A real Windows DLL that imports the Visual C++ runtime, standing in for an
// engine file. onnxruntime-node ships it on every OS, so this runs on Linux CI.
const ORT_X64 = path.join(
  path.dirname(require.resolve("onnxruntime-node/package.json")),
  "bin",
  "napi-v3",
  "win32",
  "x64",
  "onnxruntime.dll"
);

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function enginePackage(extraFiles: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-cuda-package-"));
  tempDirs.push(dir);
  fs.copyFileSync(ORT_X64, path.join(dir, "ggml.dll"));
  fs.writeFileSync(path.join(dir, "whisper-server-cuda-version.txt"), "v0.0.10");
  for (const name of extraFiles) fs.writeFileSync(path.join(dir, name), "");
  return dir;
}

describe("findCudaRuntimeProblems", () => {
  test("passes a package whose runtime imports the app provides", () => {
    expect(findCudaRuntimeProblems(enginePackage())).toEqual([]);
  });

  test("names each runtime import the app does not provide", () => {
    const provided = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];

    expect(findCudaRuntimeProblems(enginePackage(), provided)).toEqual([
      "ggml.dll needs MSVCP140_1.dll, which the app does not provide",
    ]);
  });

  test("rejects a runtime copy inside the package, which the app would overwrite", () => {
    expect(findCudaRuntimeProblems(enginePackage(["MSVCP140.dll"]))).toEqual([
      "MSVCP140.dll is in the package, and the app would overwrite it with its own copy",
    ]);
  });
});
