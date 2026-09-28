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

/** Traces of the licence client and the paid plan. */
const FORBIDDEN = [
  "updates.privatetranscribe.com/licensing",
  "getMachineId",
  "get-machine-id",
  "Pro & Beta",
  "PRO_ENFORCEMENT",
  "LicensingService",
  "€29",
];

/** The one-time cleanup names the old storage key so it can delete it. */
const ALLOWED: Record<string, string[]> = {
  PRO_ENFORCEMENT: ["src/utils/legacyPlanCleanup.ts"],
};

function offenders(files: string[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    const source = read(file);
    for (const needle of FORBIDDEN) {
      if (source.includes(needle) && !ALLOWED[needle]?.includes(file)) {
        found.push(`${file}: ${needle}`);
      }
    }
  }
  return found;
}

/**
 * PrivateTranscribe is free: nothing checks a licence, identifies the machine
 * to a licensing server, or sells an upgrade. These scans keep it that way.
 */
describe("no licensing", () => {
  test("no source file under src/ holds a trace of it", () => {
    const sources = filesUnder("src");
    // An empty scan would pass without checking anything.
    expect(sources).toContain("src/components/SettingsPage.tsx");
    expect(sources).toContain("src/main.jsx");

    expect(offenders(sources)).toEqual([]);
  });

  test("neither the preload bridge nor the main process holds a trace of it", () => {
    const entryPoints = ["preload.js", "main.js"];
    for (const file of entryPoints) {
      expect(existsSync(resolve(repoRoot, file)), file).toBe(true);
    }

    expect(offenders(entryPoints)).toEqual([]);
  });

  test("the licence client, its settings tab and its scripts are deleted", () => {
    for (const file of [
      "src/services/LicensingService.ts",
      "src/components/ProSettingsSection.tsx",
      "scripts/generate-license.js",
      "scripts/stripe-test-purchase.mjs",
      "scripts/check-stripe-webhook-events.mjs",
    ]) {
      expect(existsSync(resolve(repoRoot, file)), file).toBe(false);
    }
  });
});
