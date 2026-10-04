/**
 * SHA-256 pinning for runtime downloads: the verify step itself, and the
 * `sha256` option of downloadFile that every model and engine download uses.
 * Real temp files and a local HTTP server; nothing leaves the machine.
 */

import { createHash } from "crypto";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir(), isReady: () => false },
}));

// The CommonJS fs object the helpers use, so spies see their calls.
const fs = require("fs");
const { downloadFile, verifySha256 } = require("../../../src/helpers/downloadUtils");
const GpuBinaryManager = require("../../../src/helpers/gpuBinaryManager");

const sha256Of = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

let tmpDir: string;
let server: http.Server | null = null;
let getRequests = 0;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-sha256-test-"));
  getRequests = 0;
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Serves `content`, honouring Range requests; returns the file URL. */
async function serveFile(content: Buffer, rangeRequests: string[] = []): Promise<string> {
  server = http.createServer((req, res) => {
    if (req.method === "GET") getRequests += 1;
    const range = req.headers.range;
    if (range) {
      rangeRequests.push(range);
      const offset = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
      const slice = content.subarray(offset);
      res.writeHead(206, {
        "content-range": `bytes ${offset}-${content.length - 1}/${content.length}`,
        "content-length": String(slice.length),
      });
      res.end(slice);
      return;
    }
    res.writeHead(200, { "content-length": String(content.length) });
    res.end(content);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}/model.bin`;
}

describe("verifySha256", () => {
  it("passes a file that matches its pin and leaves it in place", async () => {
    const file = path.join(tmpDir, "model.bin");
    fs.writeFileSync(file, "pinned bytes");

    await expect(verifySha256(file, sha256Of("pinned bytes").toUpperCase())).resolves.toBe(
      sha256Of("pinned bytes")
    );
    expect(fs.existsSync(file)).toBe(true);
  });

  it("deletes a file that does not match and rejects with both digests", async () => {
    const file = path.join(tmpDir, "model.bin");
    fs.writeFileSync(file, "tampered bytes");

    await expect(verifySha256(file, sha256Of("pinned bytes"))).rejects.toMatchObject({
      code: "CHECKSUM_MISMATCH",
      expectedSha256: sha256Of("pinned bytes"),
      actualSha256: sha256Of("tampered bytes"),
    });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("streams the file through the hash instead of reading it whole", async () => {
    const file = path.join(tmpDir, "model.bin");
    const content = Buffer.alloc(3 * 1024 * 1024 + 7, 0x5a); // several read chunks
    fs.writeFileSync(file, content);
    const createReadStream = vi.spyOn(fs, "createReadStream");
    const readFileSync = vi.spyOn(fs, "readFileSync");
    const readFile = vi.spyOn(fs.promises, "readFile");

    await expect(verifySha256(file, sha256Of(content))).resolves.toBe(sha256Of(content));

    const readsOf = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.filter(([target]) => target === file);
    expect(readsOf(createReadStream)).toHaveLength(1);
    expect(readsOf(readFileSync)).toHaveLength(0);
    expect(readsOf(readFile)).toHaveLength(0);
  });

  it("stops hashing when the download is cancelled and keeps the file", async () => {
    const file = path.join(tmpDir, "model.bin");
    fs.writeFileSync(file, Buffer.alloc(1024, 1));

    await expect(
      verifySha256(file, sha256Of("anything"), { signal: { aborted: true } })
    ).rejects.toMatchObject({ isAbort: true });
    expect(fs.existsSync(file)).toBe(true);
  });

  it("rejects a malformed pin without deleting the file", async () => {
    const file = path.join(tmpDir, "model.bin");
    fs.writeFileSync(file, "bytes");

    await expect(verifySha256(file, "main")).rejects.toThrow(/Invalid pinned SHA-256/);
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe("downloadFile with a pinned sha256", () => {
  it("moves a matching download into place and reports progress as before", async () => {
    const content = Buffer.from("verified model bytes");
    const url = await serveFile(content);
    const destPath = path.join(tmpDir, "model.bin");
    const progress: Array<[number, number]> = [];

    await downloadFile(url, destPath, {
      sha256: sha256Of(content),
      onProgress: (done: number, total: number) => progress.push([done, total]),
    });

    expect(fs.readFileSync(destPath)).toEqual(content);
    expect(fs.existsSync(`${destPath}.tmp`)).toBe(false);
    expect(progress.at(-1)).toEqual([content.length, content.length]);
  });

  it("deletes a mismatching download, never creates the destination, and does not retry", async () => {
    const url = await serveFile(Buffer.from("swapped upstream bytes"));
    const destPath = path.join(tmpDir, "model.bin");

    await expect(
      downloadFile(url, destPath, { sha256: sha256Of("the bytes we pinned") })
    ).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });

    expect(fs.existsSync(destPath)).toBe(false);
    expect(fs.existsSync(`${destPath}.tmp`)).toBe(false);
    expect(getRequests).toBe(1);
  });

  it("verifies the whole file once a resumed download has finished", async () => {
    const content = Buffer.alloc(4096, 0x62);
    content.write("head", 0);
    const rangeRequests: string[] = [];
    const url = await serveFile(content, rangeRequests);
    const destPath = path.join(tmpDir, "model.bin");
    fs.writeFileSync(`${destPath}.tmp`, content.subarray(0, 1000));

    await downloadFile(url, destPath, { sha256: sha256Of(content) });

    expect(rangeRequests).toEqual(["bytes=1000-"]);
    expect(fs.readFileSync(destPath)).toEqual(content);
  });

  it("rejects a malformed pin before fetching anything", async () => {
    const url = await serveFile(Buffer.from("bytes"));

    await expect(
      downloadFile(url, path.join(tmpDir, "model.bin"), { sha256: "not-a-sha" })
    ).rejects.toThrow(/Invalid pinned SHA-256/);
    expect(getRequests).toBe(0);
  });
});

describe("CUDA engine package", () => {
  it("fails a package that does not match its pin before extracting it", async () => {
    const url = await serveFile(Buffer.from("not the engine that was pinned"));
    const binDir = path.join(tmpDir, "bin");
    const manager = new GpuBinaryManager();
    manager.getBinDir = () => binDir;
    const install = vi.spyOn(manager, "installCudaPackage");
    const spec = {
      ...GpuBinaryManager.CUDA_BINARIES["win32-x64"],
      remoteUrl: url,
      sha256: sha256Of("the engine that was pinned"),
    };

    const result = await manager._runCudaDownload(spec);

    expect(result).toEqual({
      success: false,
      error: "Downloaded file does not match its pinned SHA-256 checksum",
    });
    expect(install).not.toHaveBeenCalled();
    expect(fs.readdirSync(binDir)).toEqual([]);
  });
});
