const promptData = require("../config/promptData.json");

const UNIFIED_SYSTEM_PROMPT = promptData.UNIFIED_SYSTEM_PROMPT;
const DICTIONARY_SUFFIX = promptData.DICTIONARY_SUFFIX;

function getSystemPrompt(agentName, customDictionary, dictationMode, preferredLanguage) {
  const name = (agentName && agentName.trim()) || "Assistant";
  let prompt = UNIFIED_SYSTEM_PROMPT.replace(/\{\{agentName\}\}/g, name);

  if (Array.isArray(customDictionary) && customDictionary.length > 0) {
    prompt += DICTIONARY_SUFFIX + customDictionary.join(", ");
  }

  if (dictationMode && typeof dictationMode === "string" && dictationMode.trim()) {
    prompt += `\n\nCurrent dictation mode: ${dictationMode.trim()}. Adjust your output style and formatting to suit this mode.`;
  }

  if (preferredLanguage && typeof preferredLanguage === "string" && preferredLanguage !== "auto") {
    prompt += `\n\nOUTPUT LANGUAGE: The user's preferred output language is "${preferredLanguage}" (BCP-47 code). Always write your final output in this language. If the transcribed text appears to be in a different language, treat the language mismatch as a transcription error and output in "${preferredLanguage}" instead.`;
  }

  return prompt;
}

function buildPrompt(text, agentName) {
  const systemPrompt = getSystemPrompt(agentName);
  return `${systemPrompt}\n\n${text}`;
}

module.exports = {
  UNIFIED_SYSTEM_PROMPT,
  getSystemPrompt,
  buildPrompt,
};
