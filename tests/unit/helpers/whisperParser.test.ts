/**
 * Tests for Whisper result parsing and text normalization
 * @module tests/unit/helpers/whisperParser
 */

import { tmpdir } from "os";
import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => tmpdir(),
    isReady: () => false,
  },
}));

const WhisperManager = require("../../../src/helpers/whisper");

// Inline implementations matching src/helpers/whisper.js

function normalizeWhitespace(text: string): string {
  return text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
}

function isBlankAudioMarker(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === "[blank_audio]" || normalized === "[ blank_audio ]";
}

interface ParsedResult {
  success: boolean;
  text?: string;
  message?: string;
}

interface TranscriptionSegment {
  text: string;
}

interface WhisperCliOutput {
  transcription?: TranscriptionSegment[];
}

interface WhisperServerOutput {
  text?: string;
}

type WhisperOutput = string | WhisperCliOutput | WhisperServerOutput | null;

function parseWhisperResult(output: WhisperOutput): ParsedResult {
  // Handle both string (from CLI) and object (from server) inputs
  let result: WhisperCliOutput | WhisperServerOutput;

  if (typeof output === "string") {
    try {
      result = JSON.parse(output);
    } catch {
      // Try parsing as plain text (non-JSON output)
      const text = normalizeWhitespace(output);
      if (text && !isBlankAudioMarker(text)) {
        return { success: true, text };
      }
      // Check if it's a blank audio marker specifically
      if (isBlankAudioMarker(output)) {
        return { success: false, message: "No audio detected" };
      }
      return { success: false, message: "Failed to parse Whisper output" };
    }
  } else if (typeof output === "object" && output !== null) {
    result = output;
  } else {
    return { success: false, message: "Unexpected Whisper output type" };
  }

  // Handle whisper.cpp JSON format (CLI mode)
  if ("transcription" in result && Array.isArray(result.transcription)) {
    const text = normalizeWhitespace(result.transcription.map((seg) => seg.text).join(""));
    if (!text || isBlankAudioMarker(text)) {
      return { success: false, message: "No audio detected" };
    }
    return { success: true, text };
  }

  // Handle whisper-server format (has "text" field directly)
  if ("text" in result && result.text !== undefined) {
    const text = typeof result.text === "string" ? normalizeWhitespace(result.text) : "";
    if (!text || isBlankAudioMarker(text)) {
      return { success: false, message: "No audio detected" };
    }
    return { success: true, text };
  }

  return { success: false, message: "No audio detected" };
}

describe("Whisper parsing utilities", () => {
  describe("actual WhisperManager parser", () => {
    it("returns no-audio for string blank audio markers", () => {
      const manager = new WhisperManager();

      expect(manager.parseWhisperResult("[BLANK_AUDIO]")).toEqual({
        success: false,
        message: "No audio detected",
      });
    });

    it.each(["cpu", "cuda"])(
      "reports the effective %s engine without exposing hardware identity",
      async (effectiveEngine) => {
        const manager = new WhisperManager();
        manager.serverManager.ready = true;
        manager.serverManager.stoppedDueToIdle = false;
        manager.currentServerModel = "base";
        vi.spyOn(manager.serverManager, "transcribe").mockResolvedValue({ text: "hello" });
        vi.spyOn(manager.serverManager, "getEngineStatus").mockReturnValue({ effectiveEngine });

        const result = await manager.transcribeViaServer(Buffer.from("audio"), "base", "en");

        expect(result).toMatchObject({
          success: true,
          text: "hello",
          computeMode: effectiveEngine,
        });
        expect(result).not.toHaveProperty("hardware");
      }
    );

    it("normalizes spaces before punctuation in server text", () => {
      const manager = new WhisperManager();

      expect(manager.parseWhisperResult({ text: "Can we test this ?" })).toEqual({
        success: true,
        text: "Can we test this?",
      });
    });

    it("removes a punctuated repeated-word hallucination from the transcript tail", () => {
      const manager = new WhisperManager();

      expect(
        manager.parseWhisperResult({
          text: "We can use a language model until a certain point. At least maybe... Yeah. Yeah. Yeah. Yeah. Yeah. Yeah. Yeah. Yeah.",
        })
      ).toEqual({
        success: true,
        text: "We can use a language model until a certain point. At least maybe...",
      });
    });

    it("collapses a long passage hallucinated twice inside a long transcription", () => {
      const manager = new WhisperManager();

      expect(
        manager.parseWhisperResult({
          text: "The night was clear, starlit and splendid after the storm passed away. The night was clear, starlit and splendid after the storm passed away. Everyone returned safely.",
        })
      ).toEqual({
        success: true,
        text: "The night was clear, starlit and splendid after the storm passed away. Everyone returned safely.",
      });
    });

    it("preserves a short sentence intentionally spoken twice", () => {
      const manager = new WhisperManager();

      expect(manager.parseWhisperResult({ text: "Please try again. Please try again." })).toEqual({
        success: true,
        text: "Please try again. Please try again.",
      });
    });
  });

  describe("normalizeWhitespace", () => {
    it("converts newlines to spaces", () => {
      expect(normalizeWhitespace("hello\nworld")).toBe("hello world");
      expect(normalizeWhitespace("line1\nline2\nline3")).toBe("line1 line2 line3");
    });

    it("collapses multiple spaces", () => {
      expect(normalizeWhitespace("hello    world")).toBe("hello world");
      expect(normalizeWhitespace("a  b   c    d")).toBe("a b c d");
    });

    it("trims leading and trailing whitespace", () => {
      expect(normalizeWhitespace("  hello  ")).toBe("hello");
      expect(normalizeWhitespace("\n\nhello\n\n")).toBe("hello");
    });

    it("handles mixed whitespace", () => {
      expect(normalizeWhitespace("  hello  \n  world  ")).toBe("hello world");
      expect(normalizeWhitespace("\t\nhello\t\nworld\n\t")).toBe("hello world");
    });

    it("handles empty string", () => {
      expect(normalizeWhitespace("")).toBe("");
    });

    it("handles whitespace-only string", () => {
      expect(normalizeWhitespace("   \n\n  ")).toBe("");
    });

    it("preserves single words", () => {
      expect(normalizeWhitespace("hello")).toBe("hello");
    });
  });

  describe("isBlankAudioMarker", () => {
    it("detects [BLANK_AUDIO] marker", () => {
      expect(isBlankAudioMarker("[BLANK_AUDIO]")).toBe(true);
    });

    it("detects [ BLANK_AUDIO ] marker with spaces", () => {
      expect(isBlankAudioMarker("[ BLANK_AUDIO ]")).toBe(true);
    });

    it("handles case insensitivity", () => {
      expect(isBlankAudioMarker("[blank_audio]")).toBe(true);
      expect(isBlankAudioMarker("[Blank_Audio]")).toBe(true);
      expect(isBlankAudioMarker("[BLANK_AUDIO]")).toBe(true);
    });

    it("handles leading/trailing whitespace", () => {
      expect(isBlankAudioMarker("  [BLANK_AUDIO]  ")).toBe(true);
      expect(isBlankAudioMarker("\n[BLANK_AUDIO]\n")).toBe(true);
    });

    it("returns false for normal text", () => {
      expect(isBlankAudioMarker("hello world")).toBe(false);
      expect(isBlankAudioMarker("This is a transcription")).toBe(false);
    });

    it("returns false for similar but different markers", () => {
      expect(isBlankAudioMarker("[BLANK]")).toBe(false);
      expect(isBlankAudioMarker("[AUDIO]")).toBe(false);
      expect(isBlankAudioMarker("BLANK_AUDIO")).toBe(false);
    });
  });

  describe("parseWhisperResult", () => {
    describe("whisper-server format (text field)", () => {
      it("parses server response with text field", () => {
        const result = parseWhisperResult({ text: "Hello, world!" });
        expect(result.success).toBe(true);
        expect(result.text).toBe("Hello, world!");
      });

      it("normalizes whitespace in server response", () => {
        const result = parseWhisperResult({ text: "Hello\n\nworld  here" });
        expect(result.success).toBe(true);
        expect(result.text).toBe("Hello world here");
      });

      it("returns failure for blank audio marker", () => {
        const result = parseWhisperResult({ text: "[BLANK_AUDIO]" });
        expect(result.success).toBe(false);
        expect(result.message).toBe("No audio detected");
      });

      it("returns failure for empty text", () => {
        const result = parseWhisperResult({ text: "" });
        expect(result.success).toBe(false);
        expect(result.message).toBe("No audio detected");
      });

      it("handles whitespace-only text", () => {
        const result = parseWhisperResult({ text: "   \n\n  " });
        expect(result.success).toBe(false);
        expect(result.message).toBe("No audio detected");
      });
    });

    describe("whisper.cpp CLI format (transcription array)", () => {
      it("parses CLI response with transcription array", () => {
        const result = parseWhisperResult({
          transcription: [{ text: "Hello, " }, { text: "world!" }],
        });
        expect(result.success).toBe(true);
        expect(result.text).toBe("Hello, world!");
      });

      it("normalizes whitespace across segments", () => {
        const result = parseWhisperResult({
          transcription: [{ text: "First part.\n" }, { text: "\nSecond part." }],
        });
        expect(result.success).toBe(true);
        expect(result.text).toBe("First part. Second part.");
      });

      it("handles single segment", () => {
        const result = parseWhisperResult({
          transcription: [{ text: "Single segment" }],
        });
        expect(result.success).toBe(true);
        expect(result.text).toBe("Single segment");
      });

      it("handles empty transcription array", () => {
        const result = parseWhisperResult({ transcription: [] });
        expect(result.success).toBe(false);
        expect(result.message).toBe("No audio detected");
      });

      it("returns failure for blank audio marker in CLI output", () => {
        const result = parseWhisperResult({
          transcription: [{ text: "[BLANK_AUDIO]" }],
        });
        expect(result.success).toBe(false);
        expect(result.message).toBe("No audio detected");
      });
    });

    describe("string input (plain text or JSON)", () => {
      it("parses JSON string with text field", () => {
        const result = parseWhisperResult('{"text": "Parsed from string"}');
        expect(result.success).toBe(true);
        expect(result.text).toBe("Parsed from string");
      });

      it("parses JSON string with transcription array", () => {
        const result = parseWhisperResult(
          '{"transcription": [{"text": "From"}, {"text": " JSON string"}]}'
        );
        expect(result.success).toBe(true);
        expect(result.text).toBe("From JSON string");
      });

      it("handles plain text (non-JSON) output", () => {
        const result = parseWhisperResult("This is plain text output");
        expect(result.success).toBe(true);
        expect(result.text).toBe("This is plain text output");
      });

      it("returns failure for plain text blank audio marker", () => {
        const result = parseWhisperResult("[BLANK_AUDIO]");
        expect(result.success).toBe(false);
        expect(result.message).toBe("No audio detected");
      });
    });

    describe("error handling", () => {
      it("returns failure for null input", () => {
        const result = parseWhisperResult(null);
        expect(result.success).toBe(false);
        expect(result.message).toBe("Unexpected Whisper output type");
      });

      it("returns failure for object without text or transcription", () => {
        const result = parseWhisperResult({ someOtherField: "value" } as WhisperOutput);
        expect(result.success).toBe(false);
        expect(result.message).toBe("No audio detected");
      });

      it("handles malformed JSON gracefully", () => {
        // This is actually plain text, so it should be treated as successful
        const result = parseWhisperResult("Not valid JSON at all");
        expect(result.success).toBe(true);
        expect(result.text).toBe("Not valid JSON at all");
      });
    });

    describe("real-world examples", () => {
      it("handles typical whisper-server response", () => {
        const serverResponse = {
          text: " Hello, this is a test transcription. ",
        };
        const result = parseWhisperResult(serverResponse);
        expect(result.success).toBe(true);
        expect(result.text).toBe("Hello, this is a test transcription.");
      });

      it("handles whisper.cpp JSON output with timing info", () => {
        const cliResponse = {
          transcription: [
            { text: " Hello" },
            { text: " everyone," },
            { text: " welcome" },
            { text: " to" },
            { text: " this" },
            { text: " test." },
          ],
        };
        const result = parseWhisperResult(cliResponse);
        expect(result.success).toBe(true);
        expect(result.text).toBe("Hello everyone, welcome to this test.");
      });

      it("handles multi-paragraph transcription", () => {
        const response = {
          text: "First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph.",
        };
        const result = parseWhisperResult(response);
        expect(result.success).toBe(true);
        expect(result.text).toBe("First paragraph here. Second paragraph here. Third paragraph.");
      });
    });
  });
});
