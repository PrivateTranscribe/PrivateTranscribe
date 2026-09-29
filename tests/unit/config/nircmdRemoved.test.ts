import { describe, expect, test } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(__dirname, "../../..");

const read = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");

/** Installed dependencies and build output are not our source, so they are skipped. */
function filesUnder(relativeDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "dist") walk(full);
      } else if (entry.isFile()) {
        found.push(relative(repoRoot, full).replace(/\\/g, "/"));
      }
    }
  };
  walk(resolve(repoRoot, relativeDir));
  return found;
}

const mentionsNircmd = (relativePath: string) => /nircmd/i.test(read(relativePath));

/**
 * NirCmd's licence allows passing it on only unmodified and free of charge, and
 * CI signs every exe it bundles. Its paste and media-pause fallbacks were already
 * dead code, so it was removed rather than shipped against its licence.
 */
describe("NirCmd removal", () => {
  test("no build config or workflow downloads or packs it", () => {
    const workflows = filesUnder(".github/workflows");
    // An empty scan would pass without checking anything.
    expect(workflows).toContain(".github/workflows/build-windows.yml");

    const configs = ["electron-builder.json", "package.json", ...workflows];
    expect(configs.filter(mentionsNircmd)).toEqual([]);
  });

  test("no source file mentions it", () => {
    const sources = filesUnder("src");
    expect(sources).toContain("src/helpers/mediaController.js");

    expect(sources.filter(mentionsNircmd)).toEqual([]);
  });

  test("its download script is gone", () => {
    expect(existsSync(resolve(repoRoot, "scripts/download-nircmd.js"))).toBe(false);
  });

  test("the paste target module no longer exports the NirCmd paste chord", () => {
    const lines = read("src/helpers/windowsPasteTarget.js")
      .split("\n")
      .filter((line) => line.includes("getWindowsPasteShortcut"));
    expect(lines).toEqual([]);
  });
});
