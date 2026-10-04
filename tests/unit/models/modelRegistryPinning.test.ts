/**
 * Every model the app downloads at runtime must carry a pinned SHA-256, and a
 * Hugging Face URL must name a commit: a branch like "main" can move under the
 * pin, which would fail every download.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { modelRegistry } from "../../../src/models/ModelRegistry";

interface PinnedFile {
  sha256?: string;
}

interface RegistryData {
  whisperModels: Record<string, PinnedFile & { downloadUrl: string }>;
  parakeetModels: Record<string, PinnedFile & { downloadUrl: string }>;
  kokoroModels: Record<string, { files: Array<PinnedFile & { relPath: string; url: string }> }>;
}

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

const registry: RegistryData = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "src", "models", "modelRegistryData.json"), "utf8")
);

function expectImmutableUrl(url: string) {
  const parsed = new URL(url);
  expect(parsed.protocol).toBe("https:");
  expect(url).not.toContain("/resolve/main/");
  if (parsed.hostname === "huggingface.co") {
    // https://huggingface.co/<owner>/<repo>/resolve/<commit>/<file>
    const [, , , resolve, revision] = parsed.pathname.split("/");
    expect(resolve).toBe("resolve");
    expect(revision).toMatch(COMMIT);
  }
}

describe("runtime download pins", () => {
  it.each(Object.entries(registry.whisperModels))("Whisper model %s", (_id, model) => {
    expect(model.sha256).toMatch(SHA256);
    expectImmutableUrl(model.downloadUrl);
  });

  it.each(Object.entries(registry.parakeetModels))("Parakeet model %s", (_id, model) => {
    expect(model.sha256).toMatch(SHA256);
    expectImmutableUrl(model.downloadUrl);
  });

  it.each(
    Object.entries(registry.kokoroModels).flatMap(([id, model]) =>
      model.files.map((file) => [`${id} ${file.relPath}`, file] as const)
    )
  )("Kokoro file %s", (_label, file) => {
    expect(file.sha256).toMatch(SHA256);
    expectImmutableUrl(file.url);
  });

  it.each(
    modelRegistry
      .getAllProviders()
      .flatMap((provider) => provider.models.map((model) => [model.id, provider, model] as const))
  )("local AI model %s", (_id, provider, model) => {
    expect(model.sha256).toMatch(SHA256);
    expect(model.hfRevision).toMatch(COMMIT);
    // checkModelValid compares the file on disk with this exact size for pinned models.
    expect(Number.isSafeInteger(model.sizeBytes) && model.sizeBytes > 0).toBe(true);
    expectImmutableUrl(provider.getDownloadUrl(model));
  });

  it("leaves no download anywhere in the registry without a pin", () => {
    // Catches a new section of downloads that the cases above do not know about.
    const unpinned: string[] = [];
    const visit = (node: unknown, trail: string): void => {
      if (Array.isArray(node)) {
        node.forEach((child, index) => visit(child, `${trail}[${index}]`));
        return;
      }
      if (!node || typeof node !== "object") return;
      const entry = node as Record<string, unknown>;
      const downloadable =
        "downloadUrl" in entry || "url" in entry || ("hfRepo" in entry && "fileName" in entry);
      if (downloadable && !SHA256.test(String(entry.sha256))) unpinned.push(trail);
      for (const [key, child] of Object.entries(entry)) visit(child, `${trail}.${key}`);
    };

    visit(registry, "registry");
    expect(unpinned).toEqual([]);
  });
});
