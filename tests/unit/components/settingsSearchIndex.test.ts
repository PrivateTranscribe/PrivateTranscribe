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
  "src/components/pages/DictionaryPage.tsx",
  "src/components/ui/MicrophoneSettings.tsx",
];

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
    const missing = [...sourceLabels].filter((label) => !indexLabels.has(label));

    // Every row left in these files is reachable now: the two switch cases that
    // could never render were deleted along with their duplicated controls.
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

describe("every settings section can actually be opened", () => {
  /**
   * `SettingsSectionType` is a type, so nothing checks it at runtime. A member
   * with no tab to select it produces a switch case that never renders - which
   * is how "dictionary" and "aiModels" sat in this file holding their own copies
   * of controls that had already moved to their own pages, with a llama idle
   * timeout nobody could reach.
   */
  const between = (source: string, start: string, end: string) => {
    const from = source.indexOf(start);
    return source.slice(from, source.indexOf(end, from + start.length));
  };

  const sectionMembers = [
    ...between(
      readFileSync(join(ROOT, "src/components/SettingsPage.tsx"), "utf8"),
      "export type SettingsSectionType =",
      ";"
    ).matchAll(/"([a-zA-Z]+)"/g),
  ].map((match) => match[1]);

  const tabIds = [
    ...between(
      readFileSync(join(ROOT, "src/components/pages/SettingsPageWrapper.tsx"), "utf8"),
      "const getSettingsTabs",
      "];"
    ).matchAll(/\bid:\s*"([a-zA-Z]+)"/g),
  ].map((match) => match[1]);

  const ipcTabs = [
    ...between(
      readFileSync(join(ROOT, "src/types/electron.ts"), "utf8"),
      "export type ControlPanelSettingsTab =",
      ";"
    ).matchAll(/"([a-zA-Z]+)"/g),
  ].map((match) => match[1]);

  it("reads all three lists", () => {
    expect(sectionMembers.length).toBeGreaterThan(0);
    expect(tabIds.length).toBeGreaterThan(0);
    expect(ipcTabs.length).toBeGreaterThan(0);
  });

  /**
   * Sections that a sidebar page renders directly instead of a Settings tab.
   * Dictation is the product, so its setup is a page; SettingsPage still owns
   * the JSX because the picker and hotkey rows are wired into its state.
   */
  const pageOwnedSections = ["dictation"];

  it("has a tab or a page for every section the settings page can render", () => {
    const tabSections = sectionMembers.filter((id) => !pageOwnedSections.includes(id));
    expect([...tabSections].sort()).toEqual([...tabIds].sort());
    for (const id of pageOwnedSections) {
      expect(sectionMembers).toContain(id);
      expect(readFileSync(join(ROOT, "src/components/AppSidebar.tsx"), "utf8")).toContain(
        `id: "${id}"`
      );
    }
  });

  it("accepts the same tabs over IPC as the tab bar offers", () => {
    expect([...ipcTabs].sort()).toEqual([...tabIds].sort());
  });
});

describe("searching settings", () => {
  const labelsFor = (query: string) => searchSettings(query).map((entry) => entry.label);

  it("finds a row by its own name", () => {
    expect(labelsFor("history limit")[0]).toBe("History limit");
  });

  it("finds a row by a word only its group heading uses", () => {
    // The row is called "While recording"; nothing in the label says
    // "ducking", which is what a person who knows the term searches for.
    expect(labelsFor("ducking")).toContain("While recording");
  });

  it("finds a row by a synonym the UI never shows", () => {
    expect(labelsFor("telemetry")).toContain("Optional product analytics");
    expect(labelsFor("nvidia")).toContain("GPU engine");
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
