const promptData = require("../config/promptData.json");

const UNIFIED_SYSTEM_PROMPT = promptData.UNIFIED_SYSTEM_PROMPT;
const DICTIONARY_SUFFIX = promptData.DICTIONARY_SUFFIX;

function getSystemPrompt(agentName, customDictionary, dictationMode) {
  const name = (agentName && agentName.trim()) || "Assistant";
  let prompt = UNIFIED_SYSTEM_PROMPT.replace(/\{\{agentName\}\}/g, name);

  if (Array.isArray(customDictionary) && customDictionary.length > 0) {
    prompt += DICTIONARY_SUFFIX + customDictionary.join(", ");
  }

  if (dictationMode && typeof dictationMode === "string" && dictationMode.trim()) {
    prompt += `\n\nCurrent dictation mode: ${dictationMode.trim()}. Adjust your output style and formatting to suit this mode.`;
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
