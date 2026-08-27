/**
 * Tests for languageCompat utilities
 * @module tests/unit/utils/languageCompat
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getModelSupportedLanguages,
  isLanguageSupported,
  resolveTranscriptionLanguage,
} from "../../../src/utils/languageCompat";

// Mock logger so tests don't need Electron IPC
vi.mock("../../../src/utils/logger", () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    logReasoning: vi.fn(),
  },
}));

// Mock ModelRegistry — only getParakeetModelInfo is used by languageCompat
vi.mock("../../../src/models/ModelRegistry", () => ({
  getParakeetModelInfo: vi.fn((modelId: string) => {
    if (modelId === "parakeet-tdt-0.6b-v3") {
      return {
        supportedLanguages: [
          "en", "es", "fr", "de", "it", "pt", "ru", "zh", "ja", "ko",
          "ar", "hi", "nl", "pl", "sv", "tr", "uk", "vi", "id", "cs",
          "ro", "hu", "fi", "da", "no",
        ],
      };
    }
    return undefined;
  }),
}));

import logger from "../../../src/utils/logger";
const mockLogger = logger as unknown as { warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getModelSupportedLanguages", () => {
  it("returns whisper's own language set, not the UI picker's", () => {
    const langs = getModelSupportedLanguages("whisper");
    expect(langs).not.toBeNull();
    expect(langs).toContain("en");
    // In whisper, absent from the 58-entry picker.
    expect(langs).toContain("yue");
    expect(langs).not.toContain("zz");
    expect(getModelSupportedLanguages("whisper", "turbo")).toEqual(langs);
  });

  it("returns language list for known parakeet model", () => {
    const langs = getModelSupportedLanguages("parakeet", "parakeet-tdt-0.6b-v3");
    expect(langs).not.toBeNull();
    expect(langs).toContain("en");
    expect(langs).toContain("es");
  });

  it("returns ['en'] fallback for unknown parakeet model", () => {
    const langs = getModelSupportedLanguages("parakeet", "unknown-model");
    expect(langs).toEqual(["en"]);
  });

  it("returns ['en'] when no modelId given for parakeet", () => {
    const langs = getModelSupportedLanguages("parakeet");
    expect(langs).toEqual(["en"]);
  });
});

describe("isLanguageSupported", () => {
  it("always returns true for 'auto'", () => {
    expect(isLanguageSupported("auto", "whisper")).toBe(true);
    expect(isLanguageSupported("auto", "parakeet", "parakeet-tdt-0.6b-v3")).toBe(true);
  });

  it("always returns true for empty/null language", () => {
    expect(isLanguageSupported("", "whisper")).toBe(true);
    expect(isLanguageSupported("", "parakeet", "parakeet-tdt-0.6b-v3")).toBe(true);
  });

  it("returns true for every language whisper actually handles", () => {
    expect(isLanguageSupported("en", "whisper")).toBe(true);
    expect(isLanguageSupported("de", "whisper")).toBe(true);
    expect(isLanguageSupported("haw", "whisper")).toBe(true); // not in the picker
  });

  it("returns false for a code whisper does not know", () => {
    // Passing this through killed whisper-server outright (audit F3).
    expect(isLanguageSupported("zz", "whisper")).toBe(false);
  });

  it("returns true for supported parakeet language", () => {
    expect(isLanguageSupported("en", "parakeet", "parakeet-tdt-0.6b-v3")).toBe(true);
    expect(isLanguageSupported("fr", "parakeet", "parakeet-tdt-0.6b-v3")).toBe(true);
  });

  it("returns false for unsupported parakeet language", () => {
    expect(isLanguageSupported("ga", "parakeet", "parakeet-tdt-0.6b-v3")).toBe(false); // Irish
    expect(isLanguageSupported("cy", "parakeet", "parakeet-tdt-0.6b-v3")).toBe(false); // Welsh
  });
});

describe("resolveTranscriptionLanguage", () => {
  it("returns null for null/undefined input", () => {
    expect(resolveTranscriptionLanguage(null, "whisper")).toBeNull();
    expect(resolveTranscriptionLanguage(undefined, "whisper")).toBeNull();
  });

  it("returns null for 'auto' (caller should omit language param)", () => {
    expect(resolveTranscriptionLanguage("auto", "whisper")).toBeNull();
    expect(resolveTranscriptionLanguage("auto", "parakeet", "parakeet-tdt-0.6b-v3")).toBeNull();
  });

  it("returns language for whisper (unrestricted)", () => {
    expect(resolveTranscriptionLanguage("en", "whisper")).toBe("en");
    expect(resolveTranscriptionLanguage("de", "whisper")).toBe("de");
    expect(resolveTranscriptionLanguage("ja", "whisper")).toBe("ja");
  });

  it("returns language for supported parakeet language", () => {
    expect(resolveTranscriptionLanguage("en", "parakeet", "parakeet-tdt-0.6b-v3")).toBe("en");
    expect(resolveTranscriptionLanguage("es", "parakeet", "parakeet-tdt-0.6b-v3")).toBe("es");
  });

  it("returns null and logs warn for unsupported parakeet language", () => {
    const result = resolveTranscriptionLanguage("ga", "parakeet", "parakeet-tdt-0.6b-v3");
    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledOnce();
    const warnCall = mockLogger.warn.mock.calls[0];
    expect(warnCall[0]).toMatch(/not supported/i);
    expect(warnCall[1]).toMatchObject({ language: "ga", modelType: "parakeet" });
  });

  it("emits debug log when language is accepted", () => {
    resolveTranscriptionLanguage("en", "parakeet", "parakeet-tdt-0.6b-v3");
    expect(mockLogger.debug).toHaveBeenCalledOnce();
    const debugCall = mockLogger.debug.mock.calls[0];
    expect(debugCall[1]).toMatchObject({ language: "en" });
  });

  it("does NOT warn when language resolves successfully", () => {
    resolveTranscriptionLanguage("en", "whisper");
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});
