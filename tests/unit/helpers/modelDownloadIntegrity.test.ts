import { createHash } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => tmpdir(),
    isReady: () => false,
  },
}));

const { verifyModelDownload } = require("../../../src/helpers/modelManagerBridge");

const temporaryDirectories: string[] = [];

function createArtifact(contents: Buffer): string {
  const directory = mkdtempSync(path.join(tmpdir(), "private-transcribe-model-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, "model.gguf");
  writeFileSync(filePath, contents);
  return filePath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("model download integrity", () => {
  it("accepts an artifact with the expected byte count and SHA-256", async () => {
    const contents = Buffer.from("verified model artifact");
    const filePath = createArtifact(contents);

    await expect(
      verifyModelDownload(filePath, {
        sizeBytes: contents.length,
        sha256: createHash("sha256").update(contents).digest("hex"),
      })
    ).resolves.toBeUndefined();
  });

  it("rejects a checksum mismatch", async () => {
    const contents = Buffer.from("altered model artifact");
    const filePath = createArtifact(contents);

    await expect(
      verifyModelDownload(filePath, {
        sizeBytes: contents.length,
        sha256: "0".repeat(64),
      })
    ).rejects.toMatchObject({ code: "DOWNLOAD_CORRUPTED" });
  });

  it("rejects an unexpected byte count before hashing", async () => {
    const filePath = createArtifact(Buffer.from("short"));

    await expect(
      verifyModelDownload(filePath, {
        sizeBytes: 100,
        sha256: "0".repeat(64),
      })
    ).rejects.toMatchObject({ code: "DOWNLOAD_CORRUPTED" });
  });
});
