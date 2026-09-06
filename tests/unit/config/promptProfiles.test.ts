import { beforeEach, describe, expect, it } from "vitest";
import { localStorageMock } from "../../setup";
import promptData from "../../../src/config/promptData.json";
import { getSystemPrompt } from "../../../src/config/prompts";
import { getSystemPrompt as mainPrompt } from "../../../src/helpers/prompts";
import {
  EXPERIMENTAL_SYSTEM_PROMPT,
  getProfilePrompt,
  getProfileTemplate,
} from "../../../src/config/promptProfiles";

beforeEach(() => {
  localStorageMock.clear();
  window.localStorage = localStorageMock;
});

describe("enhancement prompt profiles", () => {
  it("keeps the existing prompt as the default and ignores experimental style", () => {
    localStorageMock.setItem("enhancementWritingStyle", "Use short sentences.");
    expect(getProfileTemplate()).toBe(promptData.UNIFIED_SYSTEM_PROMPT);
    expect(getSystemPrompt("Nova")).toBe(mainPrompt("Nova"));
  });

  it("switches profiles without overwriting the saved current prompt", () => {
    const original = "Keep my exact style, {{agentName}}.";
    localStorageMock.setItem("customUnifiedPrompt", JSON.stringify(original));
    localStorageMock.setItem("enhancementPromptProfile", "experimental");
    expect(getProfilePrompt()).toBe(EXPERIMENTAL_SYSTEM_PROMPT);
    expect(getProfileTemplate("current")).toBe(original);
    localStorageMock.setItem("enhancementWritingStyle", "Use short sentences.");
    expect(getSystemPrompt("Nova")).toContain("Use short sentences.");
    localStorageMock.setItem("enhancementPromptProfile", "current");
    expect(getSystemPrompt("Nova")).toBe("Keep my exact style, Nova.");
    expect(localStorageMock.getItem("customUnifiedPrompt")).toBe(JSON.stringify(original));
  });

  it("keeps experimental customization separate and preserves IPC prompt parity", () => {
    localStorageMock.setItem("enhancementPromptProfile", "experimental");
    localStorageMock.setItem(
      "experimentalUnifiedPrompt",
      JSON.stringify("Experimental {{agentName}}")
    );
    const resolved = getSystemPrompt("Nova", ["Maren"], "email", "da");
    expect(resolved).toBe(mainPrompt("Nova", ["Maren"], "email", "da", getProfileTemplate()));
    expect(getProfileTemplate("current")).toBe(promptData.UNIFIED_SYSTEM_PROMPT);
  });

  it("uses explicit comparison templates regardless of the selected profile", () => {
    localStorageMock.setItem("enhancementPromptProfile", "experimental");
    expect(getSystemPrompt("Nova", [], undefined, "auto", "Frozen current prompt")).toBe(
      "Frozen current prompt"
    );
  });

  it("recovers from malformed or unknown settings and preserves legacy prompts", () => {
    localStorageMock.setItem("enhancementPromptProfile", "unknown");
    localStorageMock.setItem("customUnifiedPrompt", "{");
    expect(getProfileTemplate()).toBe(promptData.UNIFIED_SYSTEM_PROMPT);
    localStorageMock.removeItem("customUnifiedPrompt");
    localStorageMock.setItem("customPrompts", JSON.stringify({ agent: "Legacy prompt" }));
    expect(getProfileTemplate()).toBe("Legacy prompt");
  });
});
