const modelManager = require("../helpers/modelManagerBridge").default;
const debugLogger = require("../helpers/debugLogger");
const { getSystemPrompt } = require("../helpers/prompts");

const LOCAL_REASONING_MIN_CONTEXT_TOKENS = 8192;
const LOCAL_REASONING_MAX_CONTEXT_TOKENS = 32768;
const LOCAL_REASONING_MIN_OUTPUT_TOKENS = 512;
const LOCAL_REASONING_MAX_OUTPUT_TOKENS = 4096;
const LOCAL_REASONING_CONTEXT_HEADROOM_TOKENS = 512;
const CONSERVATIVE_CHARS_PER_TOKEN = 3;

const estimateTokens = (textLength) =>
  Math.max(0, Math.ceil(Number(textLength || 0) / CONSERVATIVE_CHARS_PER_TOKEN));

const roundUpToTokenBlock = (tokens, blockSize = 1024) => Math.ceil(tokens / blockSize) * blockSize;

class LocalReasoningService {
  constructor() {
    this.isProcessing = false;
  }

  async isAvailable() {
    try {
      // Check if llama.cpp is installed
      await modelManager.ensureLlamaCpp();

      // Check if at least one model is downloaded
      const models = await modelManager.getAllModels();
      return models.some((model) => model.isDownloaded);
    } catch {
      return false;
    }
  }

  async processText(text, modelId, agentName = null, config = {}) {
    debugLogger.logReasoning("LOCAL_BRIDGE_START", {
      modelId,
      agentName,
      textLength: text.length,
      hasConfig: Object.keys(config).length > 0,
    });

    if (this.isProcessing) {
      throw new Error("Already processing a request");
    }

    this.isProcessing = true;
    const startTime = Date.now();

    try {
      debugLogger.logReasoning("LOCAL_BRIDGE_PROMPT", {
        promptLength: text.length,
        hasAgentName: !!agentName,
      });

      const systemPrompt = getSystemPrompt(
        agentName,
        config.customDictionary,
        config.dictationMode,
        config.preferredLanguage
      );
      const maxTokens = config.maxTokens || this.calculateMaxTokens(text.length);
      const contextSize =
        config.contextSize ||
        this.calculateContextSize(text.length, systemPrompt.length, maxTokens);
      const inferenceConfig = {
        maxTokens,
        temperature: config.temperature || 0.7,
        topK: config.topK || 40,
        topP: config.topP || 0.9,
        repeatPenalty: config.repeatPenalty || 1.1,
        contextSize,
        threads: config.threads || 4,
        systemPrompt,
      };

      debugLogger.logReasoning("LOCAL_BRIDGE_INFERENCE", {
        modelId,
        config: inferenceConfig,
      });

      // Run inference
      const result = await modelManager.runInference(modelId, text, inferenceConfig);

      const processingTime = Date.now() - startTime;

      debugLogger.logReasoning("LOCAL_BRIDGE_SUCCESS", {
        modelId,
        processingTimeMs: processingTime,
        resultLength: result.length,
        resultPreview: result.substring(0, 100) + (result.length > 100 ? "..." : ""),
      });

      return result;
    } catch (error) {
      const processingTime = Date.now() - startTime;

      debugLogger.logReasoning("LOCAL_BRIDGE_ERROR", {
        modelId,
        processingTimeMs: processingTime,
        error: error.message,
        stack: error.stack,
      });

      throw error;
    } finally {
      this.isProcessing = false;
    }
  }

  calculateMaxTokens(
    textLength,
    minTokens = LOCAL_REASONING_MIN_OUTPUT_TOKENS,
    maxTokens = LOCAL_REASONING_MAX_OUTPUT_TOKENS
  ) {
    // Cleanup normally preserves roughly the same amount of text. Reserve a
    // modest buffer for punctuation/formatting instead of treating characters
    // as tokens, which made multi-minute dictations hit the old 2K cap.
    return Math.max(minTokens, Math.min(estimateTokens(textLength) + 512, maxTokens));
  }

  calculateContextSize(textLength, systemPromptLength, maxOutputTokens) {
    const requiredTokens =
      estimateTokens(textLength + systemPromptLength) +
      maxOutputTokens +
      LOCAL_REASONING_CONTEXT_HEADROOM_TOKENS;

    return Math.max(
      LOCAL_REASONING_MIN_CONTEXT_TOKENS,
      Math.min(roundUpToTokenBlock(requiredTokens), LOCAL_REASONING_MAX_CONTEXT_TOKENS)
    );
  }
}

module.exports = {
  default: new LocalReasoningService(),
};
