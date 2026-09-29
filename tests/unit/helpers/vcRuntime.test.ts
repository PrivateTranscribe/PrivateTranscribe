import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const {
  VC_RUNTIME_DLL,
  VC_RUNTIME_LIBRARIES,
  provideVcRuntime,
} = require("../../../src/helpers/vcRuntime");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-vc-runtime-"));
  tempDirs.push(dir);
  return dir;
}

/** An app bin folder holding every runtime library, each with distinct bytes. */
function appBin(): string {
  const dir = tempDir();
  for (const name of VC_RUNTIME_LIBRARIES) fs.writeFileSync(path.join(dir, name), `app ${name}`);
  return dir;
}

describe("provideVcRuntime", () => {
  test("copies every runtime library an engine folder lacks", async () => {
    const fromDir = appBin();
    const toDir = tempDir();

    const result = await provideVcRuntime({ fromDir, toDir });

    expect(result.copied).toEqual(VC_RUNTIME_LIBRARIES);
    for (const name of VC_RUNTIME_LIBRARIES) {
      expect(fs.readFileSync(path.join(toDir, name), "utf8")).toBe(`app ${name}`);
    }
    expect(fs.readdirSync(toDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("leaves a matching copy alone and replaces a different one", async () => {
    const fromDir = appBin();
    const toDir = tempDir();
    await provideVcRuntime({ fromDir, toDir });
    fs.writeFileSync(path.join(toDir, "msvcp140.dll"), "an older runtime");

    const result = await provideVcRuntime({ fromDir, toDir });

    expect(result.copied).toEqual(["msvcp140.dll"]);
    expect(result.unchanged).toHaveLength(VC_RUNTIME_LIBRARIES.length - 1);
    expect(fs.readFileSync(path.join(toDir, "msvcp140.dll"), "utf8")).toBe("app msvcp140.dll");
  });

  test("reports what the app lacks instead of throwing", async () => {
    const fromDir = appBin();
    fs.rmSync(path.join(fromDir, "vcomp140.dll"));

    const result = await provideVcRuntime({ fromDir, toDir: tempDir() });

    expect(result.missing).toEqual(["vcomp140.dll"]);
    expect(result.copied).toHaveLength(VC_RUNTIME_LIBRARIES.length - 1);
  });

  test("reports a copy it cannot replace and carries on with the rest", async () => {
    const fromDir = appBin();
    const toDir = tempDir();
    // A folder where the file should go, so the rename fails the way a file
    // held open by a running engine can.
    fs.mkdirSync(path.join(toDir, "vcruntime140.dll"));

    const result = await provideVcRuntime({ fromDir, toDir });

    expect(result.failed.map((failure: { name: string }) => failure.name)).toEqual([
      "vcruntime140.dll",
    ]);
    expect(result.copied).toHaveLength(VC_RUNTIME_LIBRARIES.length - 1);
    expect(fs.existsSync(path.join(toDir, "vcruntime140.dll.tmp"))).toBe(false);
  });
});

describe("VC_RUNTIME_DLL", () => {
  test("names the Visual C++ runtime DLLs in any letter case, and nothing else", () => {
    for (const name of [...VC_RUNTIME_LIBRARIES, "MSVCP140_2.dll", "VCRUNTIME140_THREADS.dll"]) {
      expect(VC_RUNTIME_DLL.test(name)).toBe(true);
    }
    for (const name of ["msvcp120.dll", "ucrtbase.dll", "cudart64_12.dll", "msvcp140.dll.tmp"]) {
      expect(VC_RUNTIME_DLL.test(name)).toBe(false);
    }
  });
});
