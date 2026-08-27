import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SPOKEN_LANGUAGES,
  buildQuickLanguageCodes,
  deriveFileLanguageDefault,
  derivePreferredLanguage,
  normalizeSpokenLanguages,
  readSpokenLanguages,
  resolveSpokenLanguages,
} from "../../../src/utils/spokenLanguages";

describe("normalizeSpokenLanguages", () => {
  it("accepts both the parsed array and the stored JSON string", () => {
    expect(normalizeSpokenLanguages(["da", "en"])).toEqual(["da", "en"]);
    expect(normalizeSpokenLanguages('["da","en"]')).toEqual(["da", "en"]);
  });

  it("drops anything that is not a language the picker offers", () => {
    expect(normalizeSpokenLanguages(["da", "auto", "klingon", "", null, 7])).toEqual(["da"]);
  });

  it("dedupes and caps, so the quick-switch menu cannot overflow", () => {
    expect(normalizeSpokenLanguages(["da", "da", "en"])).toEqual(["da", "en"]);
    const many = ["da", "en", "de", "fr", "es", "it", "ja"];
    expect(normalizeSpokenLanguages(many)).toHaveLength(MAX_SPOKEN_LANGUAGES);
  });

  it("reads a hand-edited bare code as a set of one", () => {
    expect(normalizeSpokenLanguages("da")).toEqual(["da"]);
  });
});

describe("derivePreferredLanguage", () => {
  it("pins the language outright when there is only one", () => {
    expect(derivePreferredLanguage(["da"])).toBe("da");
  });

  it("falls back to auto-detect once there is something to detect between", () => {
    expect(derivePreferredLanguage(["da", "en"])).toBe("auto");
  });

  it("stops pinning the first language once a second one is added", () => {
    // The bug this replaces: picking Danish pins preferredLanguage to "da",
    // and adding English preserved that pin. Every dictation was then forced
    // to Danish, English included, while the UI said it was detecting between
    // the two. Naming a second language means "detect between them".
    expect(derivePreferredLanguage(["da", "en"], "da")).toBe("auto");
    expect(derivePreferredLanguage(["da", "en"], "en")).toBe("auto");
  });

  it("abandons a choice the user no longer claims to speak", () => {
    expect(derivePreferredLanguage(["da", "en"], "no")).toBe("auto");
  });

  it("returns to auto-detect when the last language is removed", () => {
    // Removing the last chip has to actually clear the setting. It used to
    // keep the old pin, and resolveSpokenLanguages then read that pin back as
    // a set of one, so the chip reappeared and the language could not be
    // deleted at all.
    expect(derivePreferredLanguage([], "fr")).toBe("auto");
    expect(derivePreferredLanguage([])).toBe("auto");
    expect(resolveSpokenLanguages([], derivePreferredLanguage([], "fr"))).toEqual([]);
  });
});

describe("readSpokenLanguages", () => {
  beforeEach(() => {
    // The suite runs in the node environment; this reader is one of the few
    // pieces of renderer code the main-process side also calls into, so it
    // gets the smallest store that satisfies it.
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      clear: () => store.clear(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the stored set", () => {
    localStorage.setItem("spokenLanguages", JSON.stringify(["da", "en"]));
    expect(readSpokenLanguages()).toEqual(["da", "en"]);
  });

  it("treats an older install's single language as the spoken set", () => {
    localStorage.setItem("preferredLanguage", "da");
    expect(readSpokenLanguages()).toEqual(["da"]);
  });

  it("stays empty on auto-detect, which is not a claim about the speaker", () => {
    localStorage.setItem("preferredLanguage", "auto");
    expect(readSpokenLanguages()).toEqual([]);
  });
});

describe("deriveFileLanguageDefault", () => {
  it("falls back to auto when nothing is stored and nothing is spoken", () => {
    expect(deriveFileLanguageDefault(null, [])).toBe("auto");
    expect(deriveFileLanguageDefault(undefined, [])).toBe("auto");
  });

  it("derives the single spoken language when nothing is stored", () => {
    expect(deriveFileLanguageDefault(null, ["da"])).toBe("da");
  });

  it("derives auto-detect when nothing is stored and multiple languages are spoken", () => {
    expect(deriveFileLanguageDefault(null, ["da", "en"])).toBe("auto");
  });

  it("lets a stored choice win over any spoken set", () => {
    expect(deriveFileLanguageDefault("sv", ["da", "en"])).toBe("sv");
    expect(deriveFileLanguageDefault("sv", [])).toBe("sv");
  });

  it("treats a stored auto as a deliberate choice, not an absence of one", () => {
    // A single spoken language would otherwise derive to itself; a stored
    // "auto" still has to win, because picking Auto-detect on this page is
    // exactly as much a user choice as picking any language code.
    expect(deriveFileLanguageDefault("auto", ["da"])).toBe("auto");
  });

  it("falls back to the derived default when the stored value is not a real option", () => {
    expect(deriveFileLanguageDefault("klingon", ["da"])).toBe("da");
    expect(deriveFileLanguageDefault("", ["da"])).toBe("da");
  });
});

describe("buildQuickLanguageCodes", () => {
  it("offers auto plus the languages the user speaks", () => {
    expect(buildQuickLanguageCodes(["da", "en"], "da")).toEqual(["auto", "da", "en"]);
  });

  it("keeps a one-off choice visible so it can be undone from the overlay", () => {
    expect(buildQuickLanguageCodes(["da", "en"], "fr")).toEqual(["auto", "da", "en", "fr"]);
  });
});
