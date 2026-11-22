/**
 * A cleared assistant name must fall back to one name everywhere. The AI
 * Enhancement page showed "Hey PrivateTranscribe" while the dictation prompt
 * told the AI it was "Assistant", so the trigger phrase on the page never
 * reached instruction mode.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSystemPrompt as getRendererPrompt } from "../../../src/config/prompts";
import { getAgentName } from "../../../src/utils/agentName";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getSystemPrompt: getMainProcessPrompt } = require("../../../src/helpers/prompts");

const PROMPT = 'You are "{{agentName}}".';

function installLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  (globalThis as any).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key) : null),
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key),
  };
}

describe("assistant name fallback", () => {
  beforeEach(() => installLocalStorage({ agentName: "" }));
  afterEach(() => {
    delete (globalThis as any).localStorage;
  });

  it("gives the page and both prompt builders the same name for a cleared field", () => {
    const pageName = getAgentName();
    expect(pageName).toBe("PrivateTranscribe");
    expect(getRendererPrompt("", [], "", null, PROMPT)).toBe(`You are "${pageName}".`);
    expect(getMainProcessPrompt("", [], "", null, PROMPT)).toBe(`You are "${pageName}".`);
  });

  it("uses the same name when no name was ever stored", () => {
    expect(getRendererPrompt(null, [], "", null, PROMPT)).toBe('You are "PrivateTranscribe".');
    expect(getMainProcessPrompt(null, [], "", null, PROMPT)).toBe('You are "PrivateTranscribe".');
    expect(getMainProcessPrompt("   ", [], "", null, PROMPT)).toBe('You are "PrivateTranscribe".');
  });

  it("keeps a name the user typed", () => {
    expect(getRendererPrompt("Jarvis", [], "", null, PROMPT)).toBe('You are "Jarvis".');
    expect(getMainProcessPrompt("Jarvis", [], "", null, PROMPT)).toBe('You are "Jarvis".');
  });
});
