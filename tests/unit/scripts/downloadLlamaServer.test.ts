import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The release job signs llama-server and its DLLs, so a pinned tag is not
 * enough: an archive whose bytes differ from the recorded hash must be refused
 * before anything in it is extracted.
 */

const { verifySha256 } = require("../../../scripts/lib/download-utils");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function loadScript(archiveBytes: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-llama-download-"));
  tempDirs.push(dir);
  const bin = path.join(dir, "resources", "bin");
  fs.mkdirSync(bin, { recursive: true });

  const extracted: string[] = [];
  const downloads = {
    downloadFile: async (_url: string, file: string) => fs.writeFileSync(file, archiveBytes),
    extractArchive: (archive: string, destination: string) => {
      extracted.push(archive);
      fs.writeFileSync(path.join(destination, "llama-server.exe"), "engine");
    },
    findBinaryInDir: (destination: string, name: string) => path.join(destination, name),
    setExecutable: () => {},
    verifySha256,
  };

  const exported: { exports?: any } = {};
  const source = fs.readFileSync(path.resolve("scripts", "download-llama-server.js"), "utf8");
  vm.runInNewContext(
    source.replace(
      "main().catch(console.error);",
      "module.exports = { downloadBinary, BINARIES };"
    ),
    {
      module: exported,
      __dirname: path.join(dir, "scripts"),
      process: { env: {} },
      console: { log() {}, error() {} },
      require: (name: string) => {
        if (name === "fs") return fs;
        if (name === "path") return path;
        if (name === "./lib/download-utils") return downloads;
        throw new Error(`Unexpected module ${name}`);
      },
    }
  );

  return { script: exported.exports, bin, extracted };
}

describe("download-llama-server.js", () => {
  it("pins a SHA-256 for every archive", () => {
    const { script } = loadScript("");

    for (const config of Object.values<any>(script.BINARIES)) {
      expect(config.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("refuses an archive whose hash differs, before extracting it", async () => {
    const { script, bin, extracted } = loadScript("tampered archive");
    const release = {
      assets: [
        { name: "llama-b10566-bin-win-cpu-x64.zip", url: "https://example.invalid/archive" },
      ],
    };

    expect(
      await script.downloadBinary("win32-x64", script.BINARIES["win32-x64"], release, true)
    ).toBe(false);
    expect(extracted).toEqual([]);
    expect(fs.readdirSync(bin)).toEqual([]);
  });
});
