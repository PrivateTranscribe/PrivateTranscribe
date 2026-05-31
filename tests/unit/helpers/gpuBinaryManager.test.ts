import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => tmpdir(),
    isReady: () => false,
  },
}));

const GpuBinaryManager = require("../../../src/helpers/gpuBinaryManager");

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function listFilesRecursive(rootDir: string): string[] {
  const files: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else {
        files.push(entryPath);
      }
    }
  }
  return files;
}

function createStoreOnlyZipEntries(
  entries: Array<{ name: string; content: Buffer | string }>,
  archivePath: string
): void {
  const chunks: Buffer[] = [];
  const centralDirectoryChunks: Buffer[] = [];

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name);
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content);
    const checksum = crc32(content);
    const localHeaderOffset = chunks.reduce((total, chunk) => total + chunk.length, 0);

    const localHeader = Buffer.alloc(30 + nameBuffer.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuffer.copy(localHeader, 30);
    chunks.push(localHeader, content);

    const centralHeader = Buffer.alloc(46 + nameBuffer.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localHeaderOffset, 42);
    nameBuffer.copy(centralHeader, 46);
    centralDirectoryChunks.push(centralHeader);
  }

  const centralDirectoryOffset = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const centralDirectory = Buffer.concat(centralDirectoryChunks);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(0, 4);
  endOfCentralDirectory.writeUInt16LE(0, 6);
  endOfCentralDirectory.writeUInt16LE(centralDirectoryChunks.length, 8);
  endOfCentralDirectory.writeUInt16LE(centralDirectoryChunks.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12);
  endOfCentralDirectory.writeUInt32LE(centralDirectoryOffset, 16);
  endOfCentralDirectory.writeUInt16LE(0, 20);

  writeFileSync(archivePath, Buffer.concat([...chunks, centralDirectory, endOfCentralDirectory]));
}

function createStoreOnlyZip(sourceDir: string, archivePath: string): void {
  createStoreOnlyZipEntries(
    listFilesRecursive(sourceDir).map((filePath) => ({
      name: path.relative(sourceDir, filePath).split(path.sep).join("/"),
      content: readFileSync(filePath),
    })),
    archivePath
  );
}

describe("GpuBinaryManager CUDA package install", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("extracts the CUDA server binary and companion runtime libraries from a zip package", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "pt-cuda-package-"));
    const packageDir = path.join(tempDir, "package");
    const binDir = path.join(tempDir, "bin");
    mkdirSync(packageDir);
    mkdirSync(binDir);

    writeFileSync(path.join(packageDir, "whisper-server-win32-x64-cuda.exe"), "fake exe");
    writeFileSync(path.join(packageDir, "cudart64_12.dll"), "fake cudart");
    writeFileSync(path.join(packageDir, "cublas64_12.dll"), "fake cublas");
    writeFileSync(path.join(packageDir, "cublasLt64_12.dll"), "fake cublasLt");

    const archivePath = path.join(tempDir, "whisper-server-win32-x64-cuda.zip");
    createStoreOnlyZip(packageDir, archivePath);

    const manager = new GpuBinaryManager();
    const result = await manager.installCudaPackage(
      archivePath,
      {
        outputName: "whisper-server-win32-x64-cuda.exe",
        companionPattern: /\.dll$/i,
      },
      binDir
    );

    expect(result.binaryPath).toBe(path.join(binDir, "whisper-server-win32-x64-cuda.exe"));
    expect(result.companionCount).toBe(3);
    expect(result.binaryBytes).toBe(
      statSync(path.join(binDir, "whisper-server-win32-x64-cuda.exe")).size
    );
    expect(result.companionBytes).toBeGreaterThan(0);
    expect(result.totalBytes).toBe(result.binaryBytes + result.companionBytes);
    expect(existsSync(path.join(binDir, "whisper-server-win32-x64-cuda.exe"))).toBe(true);
    expect(existsSync(path.join(binDir, "cudart64_12.dll"))).toBe(true);
    expect(existsSync(path.join(binDir, "cublas64_12.dll"))).toBe(true);
    expect(existsSync(path.join(binDir, "cublasLt64_12.dll"))).toBe(true);
  });

  it("rejects zip entries that would escape the extraction directory", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "pt-cuda-package-"));
    const binDir = path.join(tempDir, "bin");
    mkdirSync(binDir);

    const archivePath = path.join(tempDir, "unsafe-cuda.zip");
    createStoreOnlyZipEntries(
      [
        { name: "whisper-server-win32-x64-cuda.exe", content: "fake exe" },
        { name: "../evil.dll", content: "not allowed" },
      ],
      archivePath
    );

    const manager = new GpuBinaryManager();
    await expect(
      manager.installCudaPackage(
        archivePath,
        {
          outputName: "whisper-server-win32-x64-cuda.exe",
          companionPattern: /\.dll$/i,
        },
        binDir
      )
    ).rejects.toThrow(/Unsafe path/);
    expect(existsSync(path.join(tempDir, "evil.dll"))).toBe(false);
  });
});
