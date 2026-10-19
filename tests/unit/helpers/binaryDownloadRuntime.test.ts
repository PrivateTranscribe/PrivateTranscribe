import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { expect, it } from "vitest";

it.each(["whisper", "llama"])(
  "refreshes the %s CPU executable and runtime together",
  async (kind) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-download-runtime-"));
    const bin = path.join(dir, "resources", "bin");
    fs.mkdirSync(bin, { recursive: true });
    const runtime = kind === "whisper" ? "vcruntime140.dll" : "ggml.dll";
    const archiveExecutable =
      kind === "whisper" ? "whisper-server-win32-x64-cpu.exe" : "llama-server.exe";
    const outputExecutable = `${kind === "whisper" ? "whisper" : "llama"}-server-win32-x64.exe`;
    fs.writeFileSync(path.join(bin, runtime), "old runtime");
    fs.writeFileSync(path.join(bin, outputExecutable), "old executable");
    const extract = (_archive: string, destination: string) => {
      fs.writeFileSync(path.join(destination, archiveExecutable), "new executable");
      fs.writeFileSync(path.join(destination, runtime), "matching runtime");
      fs.writeFileSync(path.join(destination, "README.txt"), "not a runtime library");
    };
    const downloads = {
      downloadFile: async (_url: string, file: string) => fs.writeFileSync(file, "archive"),
      extractZip: extract,
      extractArchive: extract,
      setExecutable: () => {},
      findBinaryInDir: (destination: string, name: string) => path.join(destination, name),
      verifySha256: require("../../../scripts/lib/download-utils").verifySha256,
    };
    const script = kind === "whisper" ? "download-whisper-cpp.js" : "download-llama-server.js";
    const source = fs.readFileSync(path.resolve("scripts", script), "utf8");
    const exported: { exports?: any } = {};
    try {
      // Run the real downloader with local archive I/O, omitting only CLI startup.
      vm.runInNewContext(
        source.replace(
          /^main\(\)\.catch[\s\S]*$/m,
          "module.exports = { downloadBinary, BINARIES };"
        ),
        {
          module: exported,
          __dirname: path.join(dir, "scripts"),
          process,
          console: { log() {}, error() {} },
          require: (name: string) => {
            if (name === "fs") return fs;
            if (name === "path") return path;
            if (name === "./lib/download-utils") return downloads;
            throw new Error(`Unexpected module ${name}`);
          },
        }
      );
      const config = {
        ...exported.exports.BINARIES["win32-x64"],
        sha256: crypto.createHash("sha256").update("archive").digest("hex"),
      };
      // whisper downloads from its pinned release by name; llama still looks
      // the asset up in the release it fetched.
      const downloaded =
        kind === "whisper"
          ? await exported.exports.downloadBinary("win32-x64", config, true)
          : await exported.exports.downloadBinary(
              "win32-x64",
              config,
              {
                assets: [
                  {
                    name: "llama-b10566-bin-win-cpu-x64.zip",
                    url: "https://example.invalid/archive",
                  },
                ],
              },
              true
            );
      expect(downloaded).toBe(true);
      expect(fs.readFileSync(path.join(bin, outputExecutable), "utf8")).toBe("new executable");
      expect(fs.readFileSync(path.join(bin, runtime), "utf8")).toBe("matching runtime");
      expect(fs.existsSync(path.join(bin, "README.txt"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);
