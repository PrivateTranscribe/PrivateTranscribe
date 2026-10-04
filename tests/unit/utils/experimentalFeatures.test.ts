import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXPERIMENTAL_FEATURES_KEY,
  areExperimentalFeaturesEnabled,
  isAgentModeActive,
  resolveExperimentalPage,
} from "../../../src/utils/experimentalFeatures";
import { navGroups, visibleNavGroups } from "../../../src/components/sidebarNav";
import {
  SETTINGS_SEARCH_INDEX,
  isExperimentalEntry,
} from "../../../src/config/settingsSearchIndex";

let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
});

const pageIds = (betaOn: boolean, experimentalOn: boolean) =>
  visibleNavGroups(navGroups, { betaOn, experimentalOn }).flatMap((group) =>
    group.items.map((item) => item.id)
  );

describe("experimental features switch", () => {
  it("is off on a fresh install and reads only an exact true", () => {
    expect(EXPERIMENTAL_FEATURES_KEY).toBe("experimentalFeatures");
    expect(areExperimentalFeaturesEnabled()).toBe(false);
    store.set(EXPERIMENTAL_FEATURES_KEY, "1");
    expect(areExperimentalFeaturesEnabled()).toBe(false);
    store.set(EXPERIMENTAL_FEATURES_KEY, "true");
    expect(areExperimentalFeaturesEnabled()).toBe(true);
  });

  it("fails closed when storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(areExperimentalFeaturesEnabled()).toBe(false);
    expect(isAgentModeActive()).toBe(false);
  });
});

describe("sidebar", () => {
  it("hides Converse and the Action Engine while the switch is off, beta or not", () => {
    for (const betaOn of [false, true]) {
      const ids = pageIds(betaOn, false);
      expect(ids).not.toContain("converse");
      expect(ids).not.toContain("action-engine");
      expect(ids).toContain("ai-enhancement");
    }
  });

  it("drops the group a hidden page leaves empty", () => {
    const labels = visibleNavGroups(navGroups, { betaOn: true, experimentalOn: false }).map(
      (group) => group.label
    );
    expect(labels).not.toContain("ADVANCED");
  });

  it("lists them as before once the switch is on", () => {
    expect(pageIds(false, true)).toContain("converse");
    expect(pageIds(false, true)).not.toContain("action-engine");
    expect(pageIds(true, true)).toEqual(expect.arrayContaining(["converse", "action-engine"]));
  });
});

describe("page routing", () => {
  it("sends a stale Converse or Action Engine id to the dashboard while off", () => {
    expect(resolveExperimentalPage("converse", false)).toBe("home");
    expect(resolveExperimentalPage("action-engine", false)).toBe("home");
  });

  it("leaves every other page, and both pages when on, untouched", () => {
    for (const page of ["home", "history", "settings", "ai-enhancement", "correction-memory"]) {
      expect(resolveExperimentalPage(page, false)).toBe(page);
    }
    expect(resolveExperimentalPage("converse", true)).toBe("converse");
    expect(resolveExperimentalPage("action-engine", true)).toBe("action-engine");
  });
});

describe("Agent Mode", () => {
  it("is off while the switch is off, without touching the saved setting", () => {
    store.set("agentModeDictationEnabled", "true");
    expect(isAgentModeActive()).toBe(false);
    expect(store.get("agentModeDictationEnabled")).toBe("true");
  });

  it("follows its own setting once the switch is on", () => {
    store.set(EXPERIMENTAL_FEATURES_KEY, "true");
    expect(isAgentModeActive()).toBe(false);
    store.set("agentModeDictationEnabled", "true");
    expect(isAgentModeActive()).toBe(true);
  });
});

describe("settings search", () => {
  it("hides Converse and Agent Mode rows but not the switch itself", () => {
    const hidden = SETTINGS_SEARCH_INDEX.filter(isExperimentalEntry);
    expect(hidden.some((entry) => entry.page === "converse")).toBe(true);
    expect(hidden.some((entry) => entry.label === "Enable agent mode")).toBe(true);
    const toggle = SETTINGS_SEARCH_INDEX.find((entry) => entry.label === "Experimental features");
    expect(toggle && isExperimentalEntry(toggle)).toBe(false);
  });
});
