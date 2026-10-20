// Request sizing and reply reading for AI cleanup through Anthropic, which
// runs in the main process to avoid CORS.

// Claude models answer up to 64K tokens; 16K covers about an hour of
// dictation while a non-streamed request stays well inside the API's limits.
const MAX_OUTPUT_TOKENS = 16384;
const MIN_OUTPUT_TOKENS = 100;

function getAnthropicMaxTokens(text, config) {
  if (config?.maxTokens) return config.maxTokens;
  const length = typeof text === "string" ? text.length : 0;
  return Math.max(MIN_OUTPUT_TOKENS, Math.min(length * 2, MAX_OUTPUT_TOKENS));
}

/**
 * The cleaned text, or an error when the reply stopped at its token limit:
 * pasting that partial text would lose the end of the dictation.
 */
function readAnthropicText(data) {
  if (data?.stop_reason === "max_tokens") {
    throw new Error("Anthropic's reply was cut off at its length limit");
  }
  const text = data?.content?.[0]?.text;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Anthropic returned an empty reply");
  }
  return text.trim();
}

module.exports = { getAnthropicMaxTokens, readAnthropicText };
