import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The whisper-server the release job signs comes from a third-party fork, so
 * the download script must take one pinned release and refuse any archive
 * whose bytes differ from the hash recorded for it. These tests run the real
 * script with the network and archive tools replaced.
 */

const { verifySha256 } = require("../../../scripts/lib/download-utils");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const sha256 = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

interface Harness {
  script: any;
  bin: string;
  urls: string[];
  extracted: string[];
  fakeProcess: { exitCode?: number };
}

/** Loads the real script into a sandbox whose downloads write `archiveBytes`. */
function loadScript(archiveBytes: string): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-whisper-download-"));
  tempDirs.push(dir);
  const bin = path.join(dir, "resources", "bin");
  fs.mkdirSync(bin, { recursive: true });

  const urls: string[] = [];
  const extracted: string[] = [];
  const fakeProcess: { exitCode?: number } = {};
  const downloads = {
    downloadFile: async (url: string, file: string) => {
      urls.push(url);
      fs.writeFileSync(file, archiveBytes);
    },
    extractZip: (archive: string, destination: string) => {
      extracted.push(archive);
      fs.writeFileSync(path.join(destination, "whisper-server-win32-x64-cpu.exe"), "engine");
    },
    parseArgs: () => ({
      platformArch: "win32-x64",
      isCurrent: true,
      isForce: false,
      shouldCleanup: false,
    }),
    setExecutable: () => {},
    cleanupFiles: () => {},
    verifySha256,
  };

  const exported: { exports?: any } = {};
  vm.runInNewContext(fs.readFileSync(path.resolve("scripts", "download-whisper-cpp.js"), "utf8"), {
    module: exported,
    __dirname: path.join(dir, "scripts"),
    process: fakeProcess,
    console: { log() {}, error() {} },
    require: (name: string) => {
      if (name === "fs") return fs;
      if (name === "path") return path;
      if (name === "./lib/download-utils") return downloads;
      throw new Error(`Unexpected module ${name}`);
    },
  });

  return { script: exported.exports, bin, urls, extracted, fakeProcess };
}

describe("download-whisper-cpp.js", () => {
  it("pins one release and a SHA-256 for every archive", () => {
    const { script } = loadScript("");

    expect(script.PINNED_VERSION).toBe("0.0.10");
    for (const config of Object.values<any>(script.BINARIES)) {
      expect(config.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("downloads from the pinned release, never from latest", async () => {
    const { script, urls } = loadScript("archive");
    const config = { ...script.BINARIES["win32-x64"], sha256: sha256("archive") };

    expect(await script.downloadBinary("win32-x64", config)).toBe(true);
    expect(urls).toEqual([
      "https://github.com/OpenWhispr/whisper.cpp/releases/download/0.0.10/whisper-server-win32-x64-cpu.zip",
    ]);
  });

  it("refuses an archive whose hash differs, before extracting it", async () => {
    const { script, bin, extracted } = loadScript("tampered archive");

    expect(await script.downloadBinary("win32-x64", script.BINARIES["win32-x64"])).toBe(false);
    expect(extracted).toEqual([]);
    expect(fs.readdirSync(bin)).toEqual([]);
  });

  it("fails the build on a mismatch", async () => {
    const { script, fakeProcess } = loadScript("tampered archive");

    await script.main();

    expect(fakeProcess.exitCode).toBe(1);
  });
});

describe("verifySha256", () => {
  it("accepts the matching hash and names the file on a mismatch", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-sha256-"));
    tempDirs.push(dir);
    const file = path.join(dir, "engine.zip");
    fs.writeFileSync(file, "archive");

    expect(() => verifySha256(file, sha256("archive"))).not.toThrow();
    expect(() => verifySha256(file, sha256("other"))).toThrow(/SHA-256 mismatch for engine\.zip/);
    expect(() => verifySha256(file, "")).toThrow(/No SHA-256 is pinned for engine\.zip/);
  });
});
