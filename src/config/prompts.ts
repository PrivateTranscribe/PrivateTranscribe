import promptData from "./promptData.json";

export const UNIFIED_SYSTEM_PROMPT = promptData.UNIFIED_SYSTEM_PROMPT;
const DICTIONARY_SUFFIX = promptData.DICTIONARY_SUFFIX;

export function getSystemPrompt(
  agentName: string | null,
  customDictionary?: string[],
  dictationMode?: string,
  preferredLanguage?: string | null,
  customSystemPrompt?: string
): string {
  const name = agentName?.trim() || "Assistant";

  let promptTemplate =
    typeof customSystemPrompt === "string" ? customSystemPrompt : UNIFIED_SYSTEM_PROMPT;
  if (customSystemPrompt === undefined && typeof window !== "undefined" && window.localStorage) {
    const customPrompt = window.localStorage.getItem("customUnifiedPrompt");
    if (customPrompt) {
      try {
        const parsed = JSON.parse(customPrompt);
        if (typeof parsed === "string") {
          promptTemplate = parsed;
        }
      } catch {
        // Use default if parsing fails
      }
    }
  }

  let prompt = promptTemplate.replace(/\{\{agentName\}\}/g, name);

  if (customDictionary && customDictionary.length > 0) {
    prompt += DICTIONARY_SUFFIX + customDictionary.join(", ");
  }

  if (dictationMode && dictationMode.trim()) {
    prompt += `\n\nCurrent dictation mode: ${dictationMode.trim()}. Adjust your output style and formatting to suit this mode.`;
  }

  if (preferredLanguage && preferredLanguage !== "auto") {
    prompt += `\n\nOUTPUT LANGUAGE: The user's preferred output language is "${preferredLanguage}" (BCP-47 code). Always write your final output in this language. If the transcribed text appears to be in a different language, treat the language mismatch as a transcription error and output in "${preferredLanguage}" instead.`;
  }

  return prompt;
}
