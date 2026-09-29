import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const { MACHINE, readFileVersion, readImports } = require("../../../scripts/lib/pe-file");
const { findUnshippedRuntimeImports } = require("../../../scripts/after-pack-win");

// onnxruntime-node ships its Windows builds on every OS, so these also run on Linux CI.
const ortBin = path.join(
  path.dirname(require.resolve("onnxruntime-node/package.json")),
  "bin",
  "napi-v3",
  "win32"
);
const ORT_X64 = path.join(ortBin, "x64", "onnxruntime.dll");
const ORT_ARM64 = path.join(ortBin, "arm64", "onnxruntime.dll");
const RUNTIME = ["MSVCP140.dll", "MSVCP140_1.dll", "VCRUNTIME140.dll", "VCRUNTIME140_1.dll"];
const ORT_PACKAGED = "resources/app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v3/win32";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** An unpacked app folder: each path maps to a file to copy, or "" for an empty file. */
function unpackedApp(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-pe-file-"));
  tempDirs.push(dir);
  for (const [relativePath, source] of Object.entries(files)) {
    const target = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (source) fs.copyFileSync(source, target);
    else fs.writeFileSync(target, "");
  }
  return dir;
}

describe("readImports", () => {
  test("reads the load-time and delay-load imports of onnxruntime.dll", () => {
    const pe = readImports(fs.readFileSync(ORT_X64));

    expect(pe.machine).toBe(MACHINE.x64);
    expect(pe.imports).toEqual(expect.arrayContaining(RUNTIME));
    expect(pe.delayImports).toContain("DirectML.dll");
    expect(pe.delayImports).not.toContain("MSVCP140.dll");
  });

  test("returns null for a file that is not a PE file", () => {
    expect(readImports(Buffer.from("not a dll"))).toBeNull();
  });
});

describe("readFileVersion", () => {
  test("reads the fixed file version that follows its signature", () => {
    const info = Buffer.alloc(16);
    info.writeUInt32LE(0xfeef04bd, 0);
    info.writeUInt32LE(0x00010000, 4);
    info.writeUInt32LE(14 * 0x10000 + 44, 8);
    info.writeUInt32LE(35211 * 0x10000, 12);

    expect(readFileVersion(Buffer.concat([Buffer.from("resources"), info]))).toEqual([
      14, 44, 35211, 0,
    ]);
  });

  test("returns null without a version resource", () => {
    expect(readFileVersion(Buffer.from("no version here"))).toBeNull();
  });
});

describe("findUnshippedRuntimeImports", () => {
  const ortDll = `${ORT_PACKAGED}/x64/onnxruntime.dll`;

  test("names each Visual C++ runtime DLL missing from the importing file's folder", () => {
    const dir = unpackedApp({ [ortDll]: ORT_X64 });

    expect(findUnshippedRuntimeImports(dir, MACHINE.x64).sort()).toEqual(
      RUNTIME.map((dll) => `${ortDll} needs ${dll}`).sort()
    );
  });

  test("passes once the runtime sits next to it, in any letter case", () => {
    const files: Record<string, string> = { [ortDll]: ORT_X64 };
    for (const dll of RUNTIME) files[`${ORT_PACKAGED}/x64/${dll.toLowerCase()}`] = "";

    expect(findUnshippedRuntimeImports(unpackedApp(files), MACHINE.x64)).toEqual([]);
  });

  test("does not count a copy in another folder, such as resources/bin", () => {
    const files: Record<string, string> = { [ortDll]: ORT_X64 };
    for (const dll of RUNTIME) files[`resources/bin/${dll.toLowerCase()}`] = "";

    expect(findUnshippedRuntimeImports(unpackedApp(files), MACHINE.x64)).toHaveLength(4);
  });

  test("skips binaries built for another architecture", () => {
    const dir = unpackedApp({ [`${ORT_PACKAGED}/arm64/onnxruntime.dll`]: ORT_ARM64 });

    expect(findUnshippedRuntimeImports(dir, MACHINE.x64)).toEqual([]);
  });
});
