/**
 * Tests for API configuration helpers
 * @module tests/unit/config/constants
 */

import { describe, it, expect } from "vitest";

// Inline implementations for testing
const normalizeBaseUrl = (value?: string | null): string => {
  if (!value) return "";

  let normalized = value.trim();
  if (!normalized) return "";

  // Remove trailing slashes first to simplify pattern matching
  normalized = normalized.replace(/\/+$/, "");

  const suffixReplacements: Array<[RegExp, string]> = [
    [/\/v1\/chat\/completions$/i, "/v1"],
    [/\/chat\/completions$/i, ""],
    [/\/v1\/responses$/i, "/v1"],
    [/\/responses$/i, ""],
    [/\/v1\/models$/i, "/v1"],
    [/\/models$/i, ""],
    [/\/v1\/audio\/transcriptions$/i, "/v1"],
    [/\/audio\/transcriptions$/i, ""],
    [/\/v1\/audio\/translations$/i, "/v1"],
    [/\/audio\/translations$/i, ""],
  ];

  for (const [pattern, replacement] of suffixReplacements) {
    if (pattern.test(normalized)) {
      normalized = normalized.replace(pattern, replacement).replace(/\/+$/, "");
    }
  }

  return normalized.replace(/\/+$/, "");
};

const buildApiUrl = (base: string, path: string): string => {
  const normalizedBase = normalizeBaseUrl(base) || "https://api.openai.com/v1";
  if (!path) {
    return normalizedBase;
  }
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
};

describe("API Configuration", () => {
  describe("normalizeBaseUrl", () => {
    describe("empty/null handling", () => {
      it("returns empty string for null", () => {
        expect(normalizeBaseUrl(null)).toBe("");
      });

      it("returns empty string for undefined", () => {
        expect(normalizeBaseUrl(undefined)).toBe("");
      });

      it("returns empty string for empty string", () => {
        expect(normalizeBaseUrl("")).toBe("");
      });

      it("returns empty string for whitespace only", () => {
        expect(normalizeBaseUrl("   ")).toBe("");
        expect(normalizeBaseUrl("\t\n")).toBe("");
      });
    });

    describe("chat completions suffix removal", () => {
      it("removes /v1/chat/completions suffix", () => {
        expect(normalizeBaseUrl("https://api.openai.com/v1/chat/completions")).toBe(
          "https://api.openai.com/v1"
        );
      });

      it("removes /chat/completions suffix without v1", () => {
        expect(normalizeBaseUrl("https://custom.api/chat/completions")).toBe("https://custom.api");
      });

      it("handles case insensitivity", () => {
        expect(normalizeBaseUrl("https://api.example.com/V1/CHAT/COMPLETIONS")).toBe(
          "https://api.example.com/v1"
        );
      });
    });

    describe("responses suffix removal", () => {
      it("removes /v1/responses suffix", () => {
        expect(normalizeBaseUrl("https://api.openai.com/v1/responses")).toBe(
          "https://api.openai.com/v1"
        );
      });

      it("removes /responses suffix without v1", () => {
        expect(normalizeBaseUrl("https://custom.api/responses")).toBe("https://custom.api");
      });
    });

    describe("models suffix removal", () => {
      it("removes /v1/models suffix", () => {
        expect(normalizeBaseUrl("https://api.openai.com/v1/models")).toBe(
          "https://api.openai.com/v1"
        );
      });

      it("removes /models suffix without v1", () => {
        expect(normalizeBaseUrl("https://custom.api/models")).toBe("https://custom.api");
      });
    });

    describe("audio transcription suffix removal", () => {
      it("removes /v1/audio/transcriptions suffix", () => {
        expect(normalizeBaseUrl("https://api.openai.com/v1/audio/transcriptions")).toBe(
          "https://api.openai.com/v1"
        );
      });

      it("removes /audio/transcriptions suffix without v1", () => {
        expect(normalizeBaseUrl("https://custom.api/audio/transcriptions")).toBe(
          "https://custom.api"
        );
      });

      it("removes /v1/audio/translations suffix", () => {
        expect(normalizeBaseUrl("https://api.openai.com/v1/audio/translations")).toBe(
          "https://api.openai.com/v1"
        );
      });
    });

    describe("trailing slash removal", () => {
      it("removes single trailing slash", () => {
        expect(normalizeBaseUrl("https://api.example.com/")).toBe("https://api.example.com");
      });

      it("removes multiple trailing slashes", () => {
        expect(normalizeBaseUrl("https://api.example.com///")).toBe("https://api.example.com");
      });

      it("removes trailing slashes after suffix removal", () => {
        expect(normalizeBaseUrl("https://api.example.com/v1/chat/completions/")).toBe(
          "https://api.example.com/v1"
        );
      });
    });

    describe("whitespace trimming", () => {
      it("trims leading whitespace", () => {
        expect(normalizeBaseUrl("  https://api.example.com")).toBe("https://api.example.com");
      });

      it("trims trailing whitespace", () => {
        expect(normalizeBaseUrl("https://api.example.com  ")).toBe("https://api.example.com");
      });

      it("trims both", () => {
        expect(normalizeBaseUrl("  https://api.example.com/v1  ")).toBe(
          "https://api.example.com/v1"
        );
      });
    });

    describe("preserves valid URLs", () => {
      it("preserves base URL without endpoint suffix", () => {
        expect(normalizeBaseUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1");
      });

      it("preserves custom base URLs", () => {
        expect(normalizeBaseUrl("https://my-llm-proxy.com")).toBe("https://my-llm-proxy.com");
      });

      it("preserves URLs with ports", () => {
        expect(normalizeBaseUrl("http://localhost:8080")).toBe("http://localhost:8080");
      });

      it("preserves URLs with paths that are not endpoints", () => {
        expect(normalizeBaseUrl("https://api.example.com/my-org/v1")).toBe(
          "https://api.example.com/my-org/v1"
        );
      });
    });
  });

  describe("buildApiUrl", () => {
    describe("with valid base and path", () => {
      it("combines base URL and path with leading slash", () => {
        expect(buildApiUrl("https://api.openai.com/v1", "/chat/completions")).toBe(
          "https://api.openai.com/v1/chat/completions"
        );
      });

      it("adds leading slash if missing from path", () => {
        expect(buildApiUrl("https://api.openai.com/v1", "chat/completions")).toBe(
          "https://api.openai.com/v1/chat/completions"
        );
      });

      it("normalizes base URL before combining", () => {
        expect(
          buildApiUrl("https://api.openai.com/v1/chat/completions", "/models")
        ).toBe("https://api.openai.com/v1/models");
      });
    });

    describe("with empty inputs", () => {
      it("returns default OpenAI base when base is empty", () => {
        expect(buildApiUrl("", "/responses")).toBe("https://api.openai.com/v1/responses");
      });

      it("returns normalized base when path is empty", () => {
        expect(buildApiUrl("https://api.example.com/v1", "")).toBe("https://api.example.com/v1");
      });

      it("returns default OpenAI base when both are empty", () => {
        expect(buildApiUrl("", "")).toBe("https://api.openai.com/v1");
      });
    });

    describe("common API endpoints", () => {
      it("builds chat completions endpoint", () => {
        expect(buildApiUrl("https://api.openai.com/v1", "/chat/completions")).toBe(
          "https://api.openai.com/v1/chat/completions"
        );
      });

      it("builds responses endpoint", () => {
        expect(buildApiUrl("https://api.openai.com/v1", "/responses")).toBe(
          "https://api.openai.com/v1/responses"
        );
      });

      it("builds transcriptions endpoint", () => {
        expect(buildApiUrl("https://api.openai.com/v1", "/audio/transcriptions")).toBe(
          "https://api.openai.com/v1/audio/transcriptions"
        );
      });

      it("builds models endpoint", () => {
        expect(buildApiUrl("https://api.openai.com/v1", "/models")).toBe(
          "https://api.openai.com/v1/models"
        );
      });
    });

    describe("with custom bases", () => {
      it("works with Groq API base", () => {
        expect(buildApiUrl("https://api.groq.com/openai/v1", "/chat/completions")).toBe(
          "https://api.groq.com/openai/v1/chat/completions"
        );
      });

      it("works with localhost", () => {
        expect(buildApiUrl("http://localhost:11434/v1", "/chat/completions")).toBe(
          "http://localhost:11434/v1/chat/completions"
        );
      });

      it("works with LAN addresses", () => {
        expect(buildApiUrl("http://192.168.1.100:8080/v1", "/models")).toBe(
          "http://192.168.1.100:8080/v1/models"
        );
      });
    });
  });
});
