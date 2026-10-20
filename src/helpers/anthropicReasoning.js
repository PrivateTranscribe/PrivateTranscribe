// Request building and reply reading for AI cleanup through Anthropic, which
// runs in the main process to avoid CORS.

// Claude models answer up to 64K tokens; 16K covers about an hour of
// dictation while a non-streamed request stays well inside the API's limits.
const MAX_OUTPUT_TOKENS = 16384;
const MIN_OUTPUT_TOKENS = 100;
// Room for a newer model's thinking on top of the cleaned text.
const MIN_THINKING_MODEL_TOKENS = 4096;

// Claude 3 and Claude 4 up to 4.6 take a temperature. From Opus 4.7 and
// Sonnet 5 on, a non-default temperature is a 400, and Sonnet 5 and Opus 5
// think by default, so their reply opens with a thinking block.
const SAMPLING_MODEL = /^claude-(?:3|(?:haiku|sonnet|opus)-4(?:-[0-6])?(?:-\d{8})?$)/;

function acceptsSampling(modelId) {
  return SAMPLING_MODEL.test(String(modelId || ""));
}

function getAnthropicMaxTokens(text, config, modelId) {
  if (config?.maxTokens) return config.maxTokens;
  const length = typeof text === "string" ? text.length : 0;
  // About a quarter token per character; half a token plus 2,048 covers other
  // languages. Never below the old limit of 2 per character up to 4,096.
  const sized = Math.min(Math.max(length * 2, MIN_OUTPUT_TOKENS), 4096);
  const grown = Math.ceil(length / 2) + 2048;
  const floor = acceptsSampling(modelId) ? sized : MIN_THINKING_MODEL_TOKENS;
  return Math.min(Math.max(floor, Math.min(grown, length * 2)), MAX_OUTPUT_TOKENS);
}

function buildAnthropicRequestBody({ text, modelId, systemPrompt, config }) {
  const body = {
    model: modelId,
    messages: [{ role: "user", content: text }],
    system: systemPrompt,
    max_tokens: getAnthropicMaxTokens(text, config, modelId),
  };
  if (acceptsSampling(modelId)) {
    body.temperature = config?.temperature || 0.3;
  } else {
    // Cleanup is an easy task: keep a thinking model's thinking short.
    body.output_config = { effort: "low" };
  }
  return body;
}

/**
 * The cleaned text from the first text block, or an error when the reply
 * stopped at its token limit: pasting that partial text would lose the end
 * of the dictation.
 */
function readAnthropicText(data) {
  if (data?.stop_reason === "max_tokens") {
    throw new Error("Anthropic's reply was cut off at its length limit");
  }
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const text = blocks.find((block) => block?.type === "text")?.text;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Anthropic returned an empty reply");
  }
  return text.trim();
}

module.exports = { buildAnthropicRequestBody, getAnthropicMaxTokens, readAnthropicText };
