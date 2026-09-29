/**
 * Dictation, file transcription and Agent mode have no daily cap. This reads
 * the sources back so a word counter, a prompt counter or its toast cannot
 * return without a test failing.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const SKIPPED_DIRS = new Set(["dist", "node_modules"]);
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|json|css|html)$/;

function readSources(dir: string, found = new Map<string, string>()): Map<string, string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) readSources(full, found);
    } else if (SOURCE_FILE.test(entry.name)) {
      const relative = path.relative(ROOT, full).split(path.sep).join("/");
      found.set(relative, fs.readFileSync(full, "utf8"));
    }
  }
  return found;
}

const sources = readSources(SRC);

// Proof the walk reached the files the caps used to live in.
const KNOWN_FILES = [
  "src/hooks/useAudioRecording.js",
  "src/components/CodingPromptSettings.tsx",
  "src/components/pages/DashboardPage.tsx",
  "src/components/pages/TranscribePage.tsx",
];

const REMOVED = [
  "Starter word limit reached",
  "Coding prompt shortcuts used up",
  "Unlimited with Pro",
  "privatetranscribe_starter_usage_v1",
  "privatetranscribe_agent_mode_usage_v1",
  "StarterUsageCard",
];

// The one-time cleanup names the old counters' keys only to delete them.
const CLEANUP = "src/utils/legacyPlanCleanup.ts";
const ALLOWED: Record<string, string[]> = {
  privatetranscribe_starter_usage_v1: [CLEANUP],
  privatetranscribe_agent_mode_usage_v1: [CLEANUP],
};

describe("no usage caps", () => {
  it.each(REMOVED)("nothing under src/ uses %s", (text) => {
    expect([...sources.keys()]).toEqual(expect.arrayContaining(KNOWN_FILES));

    const offenders = [...sources]
      .filter(([file, source]) => source.includes(text) && !ALLOWED[text]?.includes(file))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it("renders no usage card on the dashboard", () => {
    const dashboard = sources.get("src/components/pages/DashboardPage.tsx") ?? "";

    expect(dashboard).toContain("Recent dictations");
    expect(dashboard).not.toMatch(/UsageCard/);
    expect(fs.existsSync(path.join(SRC, "components", "ui", "StarterUsageCard.tsx"))).toBe(false);
  });
});
