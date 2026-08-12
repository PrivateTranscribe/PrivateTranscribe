/**
 * Guards the language rules in the real shipped prompt.
 *
 * tests/unit/config/prompts.test.ts deliberately inlines a stub prompt to test
 * the builder logic. That leaves the actual prompt text unguarded, which is
 * how it went this long without telling the model what language to write in.
 */

import { describe, it, expect } from "vitest";
import promptData from "../../../src/config/promptData.json";
import { getSystemPrompt } from "../../../src/helpers/prompts";

const PROMPT: string = promptData.UNIFIED_SYSTEM_PROMPT;

describe("Unified prompt language rules", () => {
  it("tells the model to write in the language that was spoken", () => {
    expect(PROMPT).toMatch(/LANGUAGE - ALWAYS MATCH THE SPEAKER:/);
    expect(PROMPT).toMatch(/same language the speaker used/i);
  });

  it("forbids translation in the absolute output rules, not only in prose", () => {
    // Output rules are the section the model treats as non-negotiable, so the
    // rule has to appear there too and not just in the descriptive section.
    const outputRules = PROMPT.slice(PROMPT.indexOf("OUTPUT RULES"));
    expect(outputRules).toMatch(/NEVER translate/);
  });

  it("says outright that an English prompt is not a cue to answer in English", () => {
    // The whole failure mode: an English system prompt quietly pulling Danish
    // dictation toward English output.
    expect(PROMPT).toMatch(/These instructions are written in English/);
  });

  it("covers text the model writes when addressed directly, not just cleanup", () => {
    expect(PROMPT).toMatch(/summarize or rewrite something they said in Danish, answer in Danish/i);
  });

  it("keeps a deliberately mixed-language dictation mixed", () => {
    expect(PROMPT).toMatch(/mixes languages/i);
  });

  it("yields to an explicit output language so the two rules cannot fight", () => {
    expect(PROMPT).toMatch(/if a specific OUTPUT LANGUAGE is named later in this prompt/i);
  });
});

describe("Unified prompt language rules in the built prompt", () => {
  it("ships the match-the-speaker rule when the user is on auto-detect", () => {
    // Auto-detect was the gap: getSystemPrompt only ever appended an OUTPUT
    // LANGUAGE block for an explicit choice, so auto got no guidance at all.
    const prompt = getSystemPrompt("Assistant", [], "", "auto");

    expect(prompt).toMatch(/LANGUAGE - ALWAYS MATCH THE SPEAKER:/);
    expect(prompt).not.toMatch(/OUTPUT LANGUAGE: The user's preferred output language/);
  });

  it("still appends the explicit override, and orders it after the general rule", () => {
    const prompt = getSystemPrompt("Assistant", [], "", "da");

    const generalRule = prompt.indexOf("LANGUAGE - ALWAYS MATCH THE SPEAKER:");
    const explicitRule = prompt.indexOf("OUTPUT LANGUAGE: The user's preferred output language");

    expect(generalRule).toBeGreaterThan(-1);
    expect(explicitRule).toBeGreaterThan(generalRule);
  });
});
