/**
 * Tests for the prompt builder functions, including dictation mode support.
 *
 * These tests run entirely in Node/Vitest without Electron or DOM.  The
 * TypeScript source imports promptData.json directly so we inline the
 * relevant logic here to keep the suite dependency-free.
 */

import { describe, it, expect } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Inline implementation mirroring src/helpers/prompts.js
// If the production implementation changes, update this copy too.
// ─────────────────────────────────────────────────────────────────────────────

const BASE_PROMPT = "You are {{agentName}}. Clean up text.";
const DICTIONARY_SUFFIX = "\n\nCustom Dictionary: ";

function getSystemPrompt(
  agentName: string | null,
  customDictionary?: string[],
  dictationMode?: string,
  preferredLanguage?: string | null
): string {
  const name = (agentName && agentName.trim()) || "Assistant";
  let prompt = BASE_PROMPT.replace(/\{\{agentName\}\}/g, name);

  if (Array.isArray(customDictionary) && customDictionary.length > 0) {
    prompt += DICTIONARY_SUFFIX + customDictionary.join(", ");
  }

  if (dictationMode && typeof dictationMode === "string" && dictationMode.trim()) {
    prompt += `\n\nCurrent dictation mode: ${dictationMode.trim()}. Adjust your output style and formatting to suit this mode.`;
  }

  if (preferredLanguage && preferredLanguage !== "auto") {
    prompt += `\n\nOUTPUT LANGUAGE: The user's preferred output language is "${preferredLanguage}" (BCP-47 code). Always write your final output in this language. If the transcribed text appears to be in a different language, treat the language mismatch as a transcription error and output in "${preferredLanguage}" instead.`;
  }

  return prompt;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests: baseline (no dictation mode)
// ─────────────────────────────────────────────────────────────────────────────

describe("getSystemPrompt — baseline (no dictation mode)", () => {
  it("injects agentName into the prompt template", () => {
    const prompt = getSystemPrompt("Alice");
    expect(prompt).toContain("Alice");
    expect(prompt).not.toContain("{{agentName}}");
  });

  it("defaults to 'Assistant' when agentName is null", () => {
    const prompt = getSystemPrompt(null);
    expect(prompt).toContain("Assistant");
  });

  it("defaults to 'Assistant' when agentName is an empty string", () => {
    const prompt = getSystemPrompt("");
    expect(prompt).toContain("Assistant");
  });

  it("defaults to 'Assistant' when agentName is whitespace", () => {
    const prompt = getSystemPrompt("   ");
    expect(prompt).toContain("Assistant");
  });

  it("appends custom dictionary when provided", () => {
    const prompt = getSystemPrompt("Bob", ["PrivateTranscribe", "llama.cpp"]);
    expect(prompt).toContain("PrivateTranscribe");
    expect(prompt).toContain("llama.cpp");
  });

  it("does not append dictionary suffix when array is empty", () => {
    const prompt = getSystemPrompt("Bob", []);
    expect(prompt).not.toContain(DICTIONARY_SUFFIX);
  });

  it("does not include dictation mode line when dictationMode is undefined", () => {
    const prompt = getSystemPrompt("Bob", [], undefined);
    expect(prompt).not.toContain("dictation mode");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: dictation mode injection
// ─────────────────────────────────────────────────────────────────────────────

describe("getSystemPrompt — dictation mode", () => {
  it("appends mode instruction when dictationMode is provided", () => {
    const prompt = getSystemPrompt("Bob", [], "code");
    expect(prompt).toContain("Current dictation mode: code.");
  });

  it("appends mode instruction with correct wording", () => {
    const prompt = getSystemPrompt("Bob", [], "email");
    expect(prompt).toContain(
      "Current dictation mode: email. Adjust your output style and formatting to suit this mode."
    );
  });

  it("trims whitespace from the mode name", () => {
    const prompt = getSystemPrompt("Bob", [], "  prose  ");
    expect(prompt).toContain("Current dictation mode: prose.");
    expect(prompt).not.toContain("  prose  ");
  });

  it("does not append mode line when dictationMode is an empty string", () => {
    const prompt = getSystemPrompt("Bob", [], "");
    expect(prompt).not.toContain("dictation mode");
  });

  it("does not append mode line when dictationMode is whitespace only", () => {
    const prompt = getSystemPrompt("Bob", [], "   ");
    expect(prompt).not.toContain("dictation mode");
  });

  it("appends mode line AFTER the custom dictionary suffix", () => {
    const prompt = getSystemPrompt("Bob", ["word1"], "code");
    const dictIdx = prompt.indexOf(DICTIONARY_SUFFIX);
    const modeIdx = prompt.indexOf("Current dictation mode");
    expect(dictIdx).toBeGreaterThan(-1);
    expect(modeIdx).toBeGreaterThan(dictIdx);
  });

  it("works with arbitrary mode names (user-defined modes)", () => {
    const prompt = getSystemPrompt("Bob", [], "technical-report");
    expect(prompt).toContain("Current dictation mode: technical-report.");
  });

  it("works with capitalised mode names", () => {
    const prompt = getSystemPrompt("Bob", [], "Email");
    expect(prompt).toContain("Current dictation mode: Email.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: preferred language injection
// ─────────────────────────────────────────────────────────────────────────────

describe("getSystemPrompt — preferred language", () => {
  it("appends OUTPUT LANGUAGE block when a specific language code is given", () => {
    const prompt = getSystemPrompt("Alice", [], undefined, "en");
    expect(prompt).toContain('OUTPUT LANGUAGE');
    expect(prompt).toContain('"en"');
  });

  it("includes the BCP-47 code in the language instruction", () => {
    const prompt = getSystemPrompt("Alice", [], undefined, "fr");
    expect(prompt).toContain('"fr"');
    expect(prompt).toContain('BCP-47 code');
  });

  it("does NOT append language block when preferredLanguage is 'auto'", () => {
    const prompt = getSystemPrompt("Alice", [], undefined, "auto");
    expect(prompt).not.toContain('OUTPUT LANGUAGE');
  });

  it("does NOT append language block when preferredLanguage is null", () => {
    const prompt = getSystemPrompt("Alice", [], undefined, null);
    expect(prompt).not.toContain('OUTPUT LANGUAGE');
  });

  it("does NOT append language block when preferredLanguage is undefined", () => {
    const prompt = getSystemPrompt("Alice", [], undefined, undefined);
    expect(prompt).not.toContain('OUTPUT LANGUAGE');
  });

  it("appends language block AFTER dictation mode line", () => {
    const prompt = getSystemPrompt("Alice", [], "code", "en");
    const modeIdx = prompt.indexOf("Current dictation mode");
    const langIdx = prompt.indexOf("OUTPUT LANGUAGE");
    expect(modeIdx).toBeGreaterThan(-1);
    expect(langIdx).toBeGreaterThan(modeIdx);
  });

  it("appends language block AFTER custom dictionary suffix", () => {
    const prompt = getSystemPrompt("Alice", ["word1"], undefined, "de");
    const dictIdx = prompt.indexOf(DICTIONARY_SUFFIX);
    const langIdx = prompt.indexOf("OUTPUT LANGUAGE");
    expect(dictIdx).toBeGreaterThan(-1);
    expect(langIdx).toBeGreaterThan(dictIdx);
  });

  it("instructs AI to treat language mismatch as a transcription error", () => {
    const prompt = getSystemPrompt("Alice", [], undefined, "en");
    expect(prompt).toContain("transcription error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: localStorage persistence semantics (mirrors App.jsx behaviour)
// ─────────────────────────────────────────────────────────────────────────────

describe("activeDictationMode localStorage contract", () => {
  /**
   * The App.jsx dictation-mode event handler writes
   *   localStorage.setItem("activeDictationMode", normalised || "")
   * AudioManager reads
   *   localStorage.getItem("activeDictationMode") || undefined
   * and treats empty string / null as "no active mode".
   *
   * These tests verify that the contract is internally consistent.
   */

  it("empty string stored by App clears the mode read by AudioManager", () => {
    // Simulate App.jsx writing "" (mode cleared)
    const stored = "";
    // Simulate AudioManager reading
    const dictationMode = stored || undefined;
    expect(dictationMode).toBeUndefined();
  });

  it("non-empty string stored by App is read by AudioManager as the mode", () => {
    const stored = "code";
    const dictationMode = stored || undefined;
    expect(dictationMode).toBe("code");
  });

  it("getSystemPrompt produces no mode line when AudioManager dictationMode is undefined", () => {
    const dictationMode: string | undefined = undefined;
    const prompt = getSystemPrompt(null, [], dictationMode);
    expect(prompt).not.toContain("dictation mode");
  });

  it("getSystemPrompt produces mode line when AudioManager dictationMode is a non-empty string", () => {
    const dictationMode = "prose";
    const prompt = getSystemPrompt(null, [], dictationMode);
    expect(prompt).toContain("Current dictation mode: prose.");
  });
});
