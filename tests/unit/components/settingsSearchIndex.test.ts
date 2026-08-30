/**
 * The settings search index is hand-written, because settings are hand-written
 * JSX with nothing to enumerate at runtime. A hand-written index drifts, and a
 * search that quietly stops finding a setting is worse than no search at all -
 * it answers "not found" with authority.
 *
 * So these tests read the labels back out of the source and compare. When a row
 * is added, renamed, or removed, this fails and names the row.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  SETTINGS_SEARCH_INDEX,
  searchSettings,
  type SettingsSearchEntry,
} from "../../../src/config/settingsSearchIndex";

const ROOT = join(__dirname, "..", "..", "..");

/** Files that render SettingsRow and are reachable in the shipped UI. */
const SOURCES = [
  "src/components/SettingsPage.tsx",
  "src/components/pages/ConversePage.tsx",
  "src/components/pages/ReadAloudPage.tsx",
  "src/components/ui/MicrophoneSettings.tsx",
];

/**
 * Rows the index deliberately leaves out, with the reason.
 *
 * `activeSection` can only ever hold a Settings tab id, and neither "dictionary"
 * nor "aiModels" is one, so those two switch cases cannot render. Indexing a row
 * nobody can navigate to would hand the user a result that goes nowhere.
 */
const UNREACHABLE_LABELS = new Set(["Idle shutdown (minutes) [aiModels]"]);

/** Every `<SettingsRow ... label="X">` in a file, in source order. */
function extractRowLabels(relativePath: string): string[] {
  const lines = readFileSync(join(ROOT, relativePath), "utf8").split(/\r?\n/);
  const labels: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (!/<SettingsRow\b/.test(lines[i])) continue;
    for (let j = i; j < Math.min(i + 6, lines.length); j += 1) {
      const match = lines[j].match(/\blabel="([^"]+)"/);
      if (match) {
        labels.push(match[1]);
        break;
      }
    }
  }

  return labels;
}

const sourceLabels = new Set(SOURCES.flatMap(extractRowLabels));
const indexLabels = new Set(SETTINGS_SEARCH_INDEX.map((entry) => entry.label));

describe("settings search index matches the settings that exist", () => {
  it("indexes every settings row rendered in the app", () => {
    const missing = [...sourceLabels].filter(
      (label) => !indexLabels.has(label) && !UNREACHABLE_LABELS.has(label)
    );

    // The aiModels duplicate shares its label with a reachable transcription
    // row, so a bare label comparison cannot see it. Both are covered by the
    // reachable entry; the unreachable one is documented above.
    expect(missing).toEqual([]);
  });

  it("does not index a label that no longer exists in the source", () => {
    const stale = [...indexLabels].filter((label) => !sourceLabels.has(label));

    expect(stale).toEqual([]);
  });

  it("gives every settings-page entry a tab to open", () => {
    const orphaned = SETTINGS_SEARCH_INDEX.filter(
      (entry) => entry.page === "settings" && !entry.section
    );

    expect(orphaned).toEqual([]);
  });

  it("has no duplicate destinations", () => {
    const seen = new Map<string, SettingsSearchEntry>();
    for (const entry of SETTINGS_SEARCH_INDEX) {
      const key = `${entry.page}/${entry.section || ""}/${entry.label}`;
      expect(seen.has(key)).toBe(false);
      seen.set(key, entry);
    }
  });
});

describe("searching settings", () => {
  const labelsFor = (query: string) => searchSettings(query).map((entry) => entry.label);

  it("finds a row by its own name", () => {
    expect(labelsFor("history limit")[0]).toBe("History limit");
  });

  it("finds a row by a word only its group heading uses", () => {
    // The row is called "Learn phrase and sentence rewrites"; nothing in the
    // label says "correction memory", which is what a person searches for.
    expect(labelsFor("correction memory")).toContain("Learn phrase and sentence rewrites");
  });

  it("finds a row by a synonym the UI never shows", () => {
    expect(labelsFor("telemetry")).toContain("Optional product analytics");
    expect(labelsFor("nvidia")).toContain("CUDA engine");
    expect(labelsFor("dansk")).toContain("Output language");
  });

  it("finds settings that live outside the Settings page", () => {
    const results = searchSettings("voice model");
    expect(results[0].label).toBe("Voice model");
    expect(results[0].page).toBe("read-aloud");
  });

  it("narrows as terms are added rather than widening", () => {
    const broad = searchSettings("microphone").length;
    const narrow = searchSettings("microphone built-in").length;

    expect(narrow).toBeGreaterThan(0);
    expect(narrow).toBeLessThan(broad);
  });

  it("ranks a direct label match above a mere mention", () => {
    expect(labelsFor("clipboard")[0]).toBe("Copy to clipboard");
  });

  it("returns nothing for an empty or unmatched query", () => {
    expect(searchSettings("")).toEqual([]);
    expect(searchSettings("   ")).toEqual([]);
    expect(searchSettings("qwertyuiop")).toEqual([]);
  });
});
