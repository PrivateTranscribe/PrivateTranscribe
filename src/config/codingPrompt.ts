import codingPrompt from "./codingPrompt.json";

export const DEFAULT_CODING_PROMPT = codingPrompt.systemPrompt;
export const CODING_PROMPT_STORAGE_KEY = "customCodingPrompt";

export function getCodingPrompt(): string {
  try {
    const saved = JSON.parse(window.localStorage.getItem(CODING_PROMPT_STORAGE_KEY) || "null");
    return typeof saved === "string" && saved.trim() ? saved : DEFAULT_CODING_PROMPT;
  } catch {
    return DEFAULT_CODING_PROMPT;
  }
}
