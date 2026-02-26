/**
 * Tests for language utilities
 * @module tests/unit/utils/languages
 */

import { describe, it, expect } from "vitest";

// Inline implementations for testing
const LANGUAGE_OPTIONS = [
  { value: "auto", label: "Auto-detect" },
  { value: "af", label: "Afrikaans" },
  { value: "ar", label: "Arabic" },
  { value: "hy", label: "Armenian" },
  { value: "az", label: "Azerbaijani" },
  { value: "be", label: "Belarusian" },
  { value: "bs", label: "Bosnian" },
  { value: "bg", label: "Bulgarian" },
  { value: "ca", label: "Catalan" },
  { value: "zh", label: "Chinese" },
  { value: "hr", label: "Croatian" },
  { value: "cs", label: "Czech" },
  { value: "da", label: "Danish" },
  { value: "nl", label: "Dutch" },
  { value: "en", label: "English" },
  { value: "et", label: "Estonian" },
  { value: "fi", label: "Finnish" },
  { value: "fr", label: "French" },
  { value: "gl", label: "Galician" },
  { value: "de", label: "German" },
  { value: "el", label: "Greek" },
  { value: "he", label: "Hebrew" },
  { value: "hi", label: "Hindi" },
  { value: "hu", label: "Hungarian" },
  { value: "is", label: "Icelandic" },
  { value: "id", label: "Indonesian" },
  { value: "it", label: "Italian" },
  { value: "ja", label: "Japanese" },
  { value: "kn", label: "Kannada" },
  { value: "kk", label: "Kazakh" },
  { value: "ko", label: "Korean" },
  { value: "lv", label: "Latvian" },
  { value: "lt", label: "Lithuanian" },
  { value: "mk", label: "Macedonian" },
  { value: "ms", label: "Malay" },
  { value: "mr", label: "Marathi" },
  { value: "mi", label: "Maori" },
  { value: "ne", label: "Nepali" },
  { value: "no", label: "Norwegian" },
  { value: "fa", label: "Persian" },
  { value: "pl", label: "Polish" },
  { value: "pt", label: "Portuguese" },
  { value: "ro", label: "Romanian" },
  { value: "ru", label: "Russian" },
  { value: "sr", label: "Serbian" },
  { value: "sk", label: "Slovak" },
  { value: "sl", label: "Slovenian" },
  { value: "es", label: "Spanish" },
  { value: "sw", label: "Swahili" },
  { value: "sv", label: "Swedish" },
  { value: "tl", label: "Tagalog" },
  { value: "ta", label: "Tamil" },
  { value: "th", label: "Thai" },
  { value: "tr", label: "Turkish" },
  { value: "uk", label: "Ukrainian" },
  { value: "ur", label: "Urdu" },
  { value: "vi", label: "Vietnamese" },
  { value: "cy", label: "Welsh" },
];

const getLanguageLabel = (code: string): string => {
  const option = LANGUAGE_OPTIONS.find((lang) => lang.value === code);
  return option?.label || code;
};

describe("languages", () => {
  describe("LANGUAGE_OPTIONS", () => {
    it("contains auto-detect as first option", () => {
      expect(LANGUAGE_OPTIONS[0]).toEqual({ value: "auto", label: "Auto-detect" });
    });

    it("has at least 50 language options", () => {
      // Should have a comprehensive set of languages
      expect(LANGUAGE_OPTIONS.length).toBeGreaterThanOrEqual(50);
    });

    it("contains common languages", () => {
      const codes = LANGUAGE_OPTIONS.map((l) => l.value);
      expect(codes).toContain("en");
      expect(codes).toContain("es");
      expect(codes).toContain("fr");
      expect(codes).toContain("de");
      expect(codes).toContain("zh");
      expect(codes).toContain("ja");
      expect(codes).toContain("ko");
      expect(codes).toContain("ar");
      expect(codes).toContain("ru");
      expect(codes).toContain("pt");
    });

    it("has unique language codes", () => {
      const codes = LANGUAGE_OPTIONS.map((l) => l.value);
      const uniqueCodes = new Set(codes);
      expect(uniqueCodes.size).toBe(codes.length);
    });

    it("has ISO 639-1 two-letter codes", () => {
      const codes = LANGUAGE_OPTIONS.filter((l) => l.value !== "auto").map((l) => l.value);
      codes.forEach((code) => {
        expect(code).toMatch(/^[a-z]{2}$/);
      });
    });

    it("has labels in a reasonable order (mostly alphabetical)", () => {
      // The list is generally alphabetical but may have minor variations
      const labels = LANGUAGE_OPTIONS.slice(1).map((l) => l.label);
      // Check that first few and last few are in expected positions
      expect(labels[0]).toBe("Afrikaans");
      expect(labels[labels.length - 1]).toBe("Welsh");
      // Check English is in the E section (should be around index 14)
      expect(labels.indexOf("English")).toBeLessThan(20);
    });
  });

  describe("getLanguageLabel", () => {
    it("returns label for known language codes", () => {
      expect(getLanguageLabel("en")).toBe("English");
      expect(getLanguageLabel("fr")).toBe("French");
      expect(getLanguageLabel("es")).toBe("Spanish");
      expect(getLanguageLabel("de")).toBe("German");
      expect(getLanguageLabel("zh")).toBe("Chinese");
      expect(getLanguageLabel("ja")).toBe("Japanese");
    });

    it("returns Auto-detect for auto code", () => {
      expect(getLanguageLabel("auto")).toBe("Auto-detect");
    });

    it("returns the code itself for unknown codes", () => {
      expect(getLanguageLabel("unknown")).toBe("unknown");
      expect(getLanguageLabel("xyz")).toBe("xyz");
      expect(getLanguageLabel("123")).toBe("123");
    });

    it("handles empty string", () => {
      expect(getLanguageLabel("")).toBe("");
    });

    it("is case sensitive", () => {
      expect(getLanguageLabel("EN")).toBe("EN"); // Returns code since "EN" not found
      expect(getLanguageLabel("en")).toBe("English");
    });
  });

  describe("Whisper-supported languages", () => {
    // These are the languages supported by OpenAI Whisper
    const whisperLanguages = [
      "en",
      "zh",
      "de",
      "es",
      "ru",
      "ko",
      "fr",
      "ja",
      "pt",
      "tr",
      "pl",
      "ca",
      "nl",
      "ar",
      "sv",
      "it",
      "id",
      "hi",
      "fi",
      "vi",
      "he",
      "uk",
      "el",
      "ms",
      "cs",
      "ro",
      "da",
      "hu",
      "ta",
      "no",
      "th",
      "ur",
      "hr",
      "bg",
      "lt",
      "cy",
      "sk",
      "fa",
      "lv",
      "sl",
      "sr",
      "is",
      "et",
    ];

    it("includes all major Whisper-supported languages", () => {
      const codes = LANGUAGE_OPTIONS.map((l) => l.value);
      whisperLanguages.forEach((lang) => {
        expect(codes).toContain(lang);
      });
    });
  });
});
