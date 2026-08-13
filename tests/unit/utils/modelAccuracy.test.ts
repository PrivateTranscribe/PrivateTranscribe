import { describe, it, expect } from "vitest";
import {
  getWhisperPerfRating,
  isKnownNonEnglishLanguage,
  isWeakForNonEnglish,
} from "../../../src/utils/modelAccuracy";

describe("isKnownNonEnglishLanguage", () => {
  it("treats auto and empty as unknown, not as non-English", () => {
    // We cannot show a language-specific rating for a language nobody told us.
    expect(isKnownNonEnglishLanguage("auto")).toBe(false);
    expect(isKnownNonEnglishLanguage("")).toBe(false);
    expect(isKnownNonEnglishLanguage(null)).toBe(false);
    expect(isKnownNonEnglishLanguage(undefined)).toBe(false);
  });

  it("treats English and its regional tags as English", () => {
    expect(isKnownNonEnglishLanguage("en")).toBe(false);
    expect(isKnownNonEnglishLanguage("en-GB")).toBe(false);
    expect(isKnownNonEnglishLanguage("EN")).toBe(false);
  });

  it("recognises everything else as non-English", () => {
    expect(isKnownNonEnglishLanguage("da")).toBe(true);
    expect(isKnownNonEnglishLanguage("sv")).toBe(true);
    expect(isKnownNonEnglishLanguage("de")).toBe(true);
  });
});

describe("getWhisperPerfRating", () => {
  it("drops the accuracy rating for a non-English language", () => {
    // The original bug: Base showed a middling accuracy bar to a Danish user
    // while scoring 62.8% WER, so the UI told them it would be fine.
    expect(getWhisperPerfRating("base", "en")?.quality).toBe(2);
    expect(getWhisperPerfRating("base", "da")?.quality).toBe(1);

    expect(getWhisperPerfRating("medium", "en")?.quality).toBe(4);
    expect(getWhisperPerfRating("medium", "da")?.quality).toBe(2);
  });

  it("keeps the top tier usable outside English, because it measured that way", () => {
    // turbo 15.4% and large 14.5% on Danish are the only usable results.
    expect(getWhisperPerfRating("turbo", "da")?.quality).toBe(4);
    expect(getWhisperPerfRating("large", "da")?.quality).toBe(4);
  });

  it("rates every model lower outside English than inside it, or equal at worst", () => {
    for (const model of ["tiny", "base", "small", "medium", "large", "turbo"]) {
      const english = getWhisperPerfRating(model, "en")!.quality;
      const danish = getWhisperPerfRating(model, "da")!.quality;
      expect(danish).toBeLessThanOrEqual(english);
    }
  });

  it("preserves the ordering of models within a language", () => {
    const order = ["tiny", "base", "small", "medium"];
    for (const language of ["en", "da"]) {
      const ratings = order.map((model) => getWhisperPerfRating(model, language)!.quality);
      const sorted = [...ratings].sort((a, b) => a - b);
      expect(ratings).toEqual(sorted);
    }
  });

  it("leaves speed alone, since it does not depend on language", () => {
    expect(getWhisperPerfRating("turbo", "en")?.speed).toBe(
      getWhisperPerfRating("turbo", "da")?.speed
    );
  });

  it("falls back to the general scale when the language is unknown", () => {
    expect(getWhisperPerfRating("base", "auto")?.quality).toBe(2);
    expect(getWhisperPerfRating("base")?.quality).toBe(2);
  });

  it("returns undefined for an unknown model so no meter is invented", () => {
    expect(getWhisperPerfRating("does-not-exist", "da")).toBeUndefined();
  });
});

describe("isWeakForNonEnglish", () => {
  it("flags the models that fall off the cliff, only for non-English", () => {
    expect(isWeakForNonEnglish("base", "da")).toBe(true);
    expect(isWeakForNonEnglish("medium", "da")).toBe(true);
    expect(isWeakForNonEnglish("base", "en")).toBe(false);
    expect(isWeakForNonEnglish("base", "auto")).toBe(false);
  });

  it("does not flag the tier that stays usable", () => {
    expect(isWeakForNonEnglish("turbo", "da")).toBe(false);
    expect(isWeakForNonEnglish("large", "da")).toBe(false);
  });
});
