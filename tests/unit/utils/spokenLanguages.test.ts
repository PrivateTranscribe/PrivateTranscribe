import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SPOKEN_LANGUAGES,
  buildQuickLanguageCodes,
  derivePreferredLanguage,
  normalizeSpokenLanguages,
  readSpokenLanguages,
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

  it("keeps an existing choice that is still one of the spoken languages", () => {
    // Someone who deliberately pinned Danish and then adds English should not
    // be silently moved back onto detection.
    expect(derivePreferredLanguage(["da", "en"], "da")).toBe("da");
  });

  it("abandons a choice the user no longer claims to speak", () => {
    expect(derivePreferredLanguage(["da", "en"], "no")).toBe("auto");
  });

  it("leaves the current setting alone when nothing was selected", () => {
    expect(derivePreferredLanguage([], "fr")).toBe("fr");
    expect(derivePreferredLanguage([])).toBe("auto");
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

describe("buildQuickLanguageCodes", () => {
  it("offers auto plus the languages the user speaks", () => {
    expect(buildQuickLanguageCodes(["da", "en"], "da")).toEqual(["auto", "da", "en"]);
  });

  it("keeps a one-off choice visible so it can be undone from the overlay", () => {
    expect(buildQuickLanguageCodes(["da", "en"], "fr")).toEqual(["auto", "da", "en", "fr"]);
  });
});
