import { getModelProvider, getCloudModel } from "../models/ModelRegistry";
import { SecureCache } from "../utils/SecureCache";
import { withRetry, createApiRetryStrategy } from "../utils/retry";
import {
  API_ENDPOINTS,
  DICTATION_CLEANUP_TIMEOUT,
  TOKEN_LIMITS,
  buildApiUrl,
  normalizeBaseUrl,
} from "../config/constants";
import { getSystemPrompt as buildSystemPrompt } from "../config/prompts";
import { isShortDictation } from "../utils/shortDictation";
import { getCodingPrompt } from "../config/codingPrompt";
import logger from "../utils/logger";
import { isValidApiUrl } from "../helpers/urlValidation";
import {
  extractFileContent,
  getContext,
  isLlmContextEnhancementEnabled,
  isLlmFileContentEnabled,
} from "../helpers/contextPipeline";

export interface ReasoningConfig {
  writingStyle?: "clean" | "coding";
  maxTokens?: number;
  temperature?: number;
  promptTemplate?: string;
  /** Fully resolved renderer prompt used only across the Electron IPC boundary. */
  customSystemPrompt?: string;
  timeoutMs?: number;
  maxRetries?: number;
  dictationMode?: string;
  preferredLanguage?: string | null;
  smartContext?: Record<string, unknown> | null;
  /** The whole transcript of a long session, which gets a longer deadline. */
  longSession?: boolean;
}

// Lets a provider's own timeout fire first, with its clearer message.
const DEADLINE_GRACE_MS = 1000;

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function normalizeRetryCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

// `abandon` aborts the request when processText has already given up on it,
// so a late reply is not paid for and then thrown away.
function createRequestTimeout(timeoutMs: unknown, providerName: string, abandon?: AbortSignal) {
  const durationMs = normalizePositiveInteger(timeoutMs);
  if (!durationMs) {
    return { signal: abandon, clear: () => {}, timeoutError: () => null };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), durationMs);
  const onAbandon = () => controller.abort();
  abandon?.addEventListener("abort", onAbandon);
  if (abandon?.aborted) controller.abort();
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      abandon?.removeEventListener("abort", onAbandon);
    },
    timeoutError: () =>
      controller.signal.aborted
        ? new Error(`${providerName} request timed out after ${durationMs} ms`)
        : null,
  };
}

function getApiRetryOptions(config: ReasoningConfig, signal?: AbortSignal) {
  const strategy = createApiRetryStrategy();
  const maxRetries = normalizeRetryCount(config.maxRetries);
  return {
    ...strategy,
    ...(maxRetries === undefined ? {} : { maxRetries }),
    shouldRetry: (error: any) => !signal?.aborted && strategy.shouldRetry(error),
  };
}

function truncateErrorMessage(value: unknown, maxLength = 500): string {
  const message = typeof value === "string" ? value : String(value ?? "");
  return message.length > maxLength ? `${message.slice(0, maxLength)}...` : message;
}

// Carries the HTTP status, so the retry strategy can tell a wrong key from a
// network fault.
function createApiError(message: unknown, status: number): Error & { status: number } {
  return Object.assign(new Error(truncateErrorMessage(message)), { status });
}

// A reply that stopped at its length limit holds only part of the dictation.
// Throwing makes dictation paste the raw transcript instead.
function createTruncatedError(providerName: string): Error {
  return new Error(`${providerName}'s reply was cut off at its length limit`);
}

function getTextLength(value: unknown): number | undefined {
  return typeof value === "string" ? value.length : undefined;
}

function summarizeMessageForLog(message: any): Record<string, unknown> {
  const content = message?.content;
  return {
    role: message?.role,
    contentLength:
      typeof content === "string"
        ? content.length
        : Array.isArray(content)
          ? content.reduce((sum, part) => sum + (getTextLength(part?.text) || 0), 0)
          : undefined,
  };
}

function summarizeRequestBodyForLog(requestBody: any): Record<string, unknown> {
  return {
    keys: requestBody ? Object.keys(requestBody) : [],
    model: requestBody?.model,
    temperature: requestBody?.temperature ?? requestBody?.generationConfig?.temperature,
    maxTokens:
      requestBody?.max_tokens ??
      requestBody?.max_completion_tokens ??
      requestBody?.generationConfig?.maxOutputTokens,
    store: requestBody?.store,
    messageCount: Array.isArray(requestBody?.messages) ? requestBody.messages.length : undefined,
    messages: Array.isArray(requestBody?.messages)
      ? requestBody.messages.map(summarizeMessageForLog)
      : undefined,
    inputCount: Array.isArray(requestBody?.input) ? requestBody.input.length : undefined,
    contentsCount: Array.isArray(requestBody?.contents) ? requestBody.contents.length : undefined,
    contentTextLength: Array.isArray(requestBody?.contents)
      ? requestBody.contents.reduce((sum: number, item: any) => {
          const parts = Array.isArray(item?.parts) ? item.parts : [];
          return (
            sum +
            parts.reduce(
              (partSum: number, part: any) => partSum + (getTextLength(part?.text) || 0),
              0
            )
          );
        }, 0)
      : undefined,
  };
}

function summarizeResponseForLog(response: any): Record<string, unknown> {
  return {
    hasResponse: !!response,
    responseKeys: response ? Object.keys(response) : [],
    hasChoices: Array.isArray(response?.choices),
    choicesLength: Array.isArray(response?.choices) ? response.choices.length : 0,
    hasOutput: Array.isArray(response?.output),
    outputLength: Array.isArray(response?.output) ? response.output.length : 0,
    hasCandidates: Array.isArray(response?.candidates),
    candidatesLength: Array.isArray(response?.candidates) ? response.candidates.length : 0,
    usage: response?.usage,
    usageMetadata: response?.usageMetadata,
  };
}

function summarizeApiErrorForLog(errorData: any): Record<string, unknown> {
  const error = errorData?.error;
  const message =
    typeof error === "string"
      ? error
      : typeof error?.message === "string"
        ? error.message
        : typeof errorData?.message === "string"
          ? errorData.message
          : undefined;

  return {
    keys: errorData ? Object.keys(errorData) : [],
    errorType: typeof error === "object" ? error?.type : undefined,
    errorCode: typeof error === "object" ? error?.code : undefined,
    hasMessage: typeof message === "string" && message.length > 0,
    messageLength: typeof message === "string" ? message.length : undefined,
  };
}

class ReasoningService {
  // The one cleanup running now, or null. Each call clears only its own, so a
  // request abandoned at the deadline can't free a newer one's place.
  private activeRequest: object | null = null;
  private apiKeyCache: SecureCache<string>;
  private openAiEndpointPreference = new Map<string, "responses" | "chat">();
  private static readonly OPENAI_ENDPOINT_PREF_STORAGE_KEY = "openAiEndpointPreference";
  private cacheCleanupStop: (() => void) | undefined;

  constructor() {
    this.apiKeyCache = new SecureCache();
    this.cacheCleanupStop = this.apiKeyCache.startAutoCleanup();
  }

  private getCustomDictionary(): string[] {
    if (typeof window === "undefined" || !window.localStorage) return [];
    try {
      const raw = window.localStorage.getItem("customDictionary");
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private getSystemPrompt(
    agentName: string | null,
    dictationMode?: string,
    preferredLanguage?: string | null,
    customSystemPrompt?: string
  ): string {
    return buildSystemPrompt(
      agentName,
      this.getCustomDictionary(),
      dictationMode,
      preferredLanguage,
      customSystemPrompt
    );
  }

  private calculateMaxTokens(
    textLength: number,
    minTokens = 100,
    maxTokens = 2048,
    multiplier = 2
  ): number {
    return Math.max(minTokens, Math.min(textLength * multiplier, maxTokens));
  }

  /**
   * Build the user prompt, optionally prepending a context block.
   *
   * Context inclusion is gated on the separate `llmContextEnhancement` toggle.
   * When `config.smartContext` is provided (pre-fetched by AudioManager), it is
   * used directly — avoiding a redundant IPC round-trip. If not provided, context
   * is fetched lazily with a 2 s timeout.
   *
   * @param text       Raw transcribed text.
   * @param config     ReasoningConfig containing optional pre-fetched smartContext.
   */
  private async buildUserPrompt(text: string, config: ReasoningConfig = {}): Promise<string> {
    if (!isLlmContextEnhancementEnabled()) {
      return text;
    }

    try {
      // Use pre-fetched context when available (shared pipeline, no re-capture needed)
      const ctx =
        config.smartContext !== undefined
          ? config.smartContext
          : await getContext({ timeoutMs: 2000 });

      if (!ctx || !(ctx as any).available) {
        if ((ctx as any)?.blocked) {
          logger.logReasoning("ACTIVE_WINDOW_CONTEXT_BLOCKED", {
            enabled: true,
            reason: (ctx as any)?.reason || "blocked",
          });
        } else {
          logger.logReasoning("ACTIVE_WINDOW_CONTEXT_UNAVAILABLE", {
            enabled: true,
            reason: (ctx as any)?.reason || "unknown",
          });
        }
        return text;
      }

      const c = ctx as any;
      const lines: string[] = [];
      if (c.platform) lines.push(`Platform: ${c.platform}`);
      if (c.appName) lines.push(`App: ${c.appName}`);
      if (c.processName) lines.push(`Process: ${c.processName}`);
      if (c.appClass) lines.push(`App class: ${c.appClass}`);
      if (c.windowTitle) lines.push(`Window title: ${c.windowTitle}`);
      if (c.uiaText) lines.push(`Focused element text: ${c.uiaText}`);

      const contextBlock =
        lines.length > 0
          ? `Frontmost window context (best-effort, sanitized):\n${lines
              .map((l) => `- ${l}`)
              .join("\n")}\n\n`
          : "";

      let fileContentBlock = "";
      if (isLlmFileContentEnabled() && c.windowTitle) {
        const fileCtx = await extractFileContent(c.windowTitle, c.processName, {
          timeoutMs: 300,
          maxChars: 4000,
        });
        if (fileCtx?.available && fileCtx.excerpt) {
          const truncationNote = fileCtx.truncated ? "\n[Excerpt truncated for prompt size.]" : "";
          fileContentBlock = `Active file excerpt (${fileCtx.filename || "current file"}):\n\n\`\`\`\n${fileCtx.excerpt}\n\`\`\`${truncationNote}\n\n`;
        }
      }

      logger.logReasoning("ACTIVE_WINDOW_CONTEXT_INCLUDED", {
        enabled: true,
        platform: c.platform || "unknown",
        hasWindowTitle: !!c.windowTitle,
        hasUiaText: !!c.uiaText,
        uiaMethod: c.uiaMethod || undefined,
        source: c.source || "unknown",
        hasFileContent: Boolean(fileContentBlock),
      });

      return `${contextBlock}${fileContentBlock}${text}`;
    } catch (error) {
      logger.logReasoning("ACTIVE_WINDOW_CONTEXT_ERROR", {
        enabled: true,
        error: (error as Error)?.message || String(error),
      });
      return text;
    }
  }

  private getSelectedProvider(): string {
    if (typeof window === "undefined" || !window.localStorage) return "";
    return window.localStorage.getItem("reasoningProvider") || "";
  }

  /**
   * The base URL for OpenAI-style requests. With the custom endpoint selected it
   * is the saved address or an error, never api.openai.com in its place: that
   * would send the dictation to a provider the user did not choose.
   */
  private getConfiguredOpenAIBase(isCustomProvider: boolean): string {
    if (!isCustomProvider) {
      return API_ENDPOINTS.OPENAI_BASE;
    }

    const stored = (window.localStorage.getItem("cloudReasoningBaseUrl") || "").trim();
    if (!stored) {
      logger.logReasoning("CUSTOM_REASONING_ENDPOINT_REJECTED", { reason: "no address" });
      throw new Error("The custom endpoint has no address. Add one in AI enhancement settings.");
    }

    const normalized = normalizeBaseUrl(stored);
    const knownProvider = [
      { host: "api.groq.com", name: "Groq" },
      { host: "api.anthropic.com", name: "Anthropic" },
      { host: "generativelanguage.googleapis.com", name: "Gemini" },
    ].find(({ host }) => normalized.includes(host));
    if (knownProvider) {
      logger.logReasoning("CUSTOM_REASONING_ENDPOINT_REJECTED", {
        reason: "known non-OpenAI provider",
        attempted: normalized,
      });
      throw new Error(
        `The custom endpoint points at ${knownProvider.name}. Choose the ${knownProvider.name} provider instead.`
      );
    }

    const validation = isValidApiUrl(normalized);
    if (!validation.valid) {
      logger.logReasoning("CUSTOM_REASONING_ENDPOINT_REJECTED", {
        reason: validation.reason,
        attempted: normalized,
      });
      throw new Error(`The custom endpoint address can't be used. ${validation.reason}`);
    }

    logger.logReasoning("CUSTOM_REASONING_ENDPOINT_RESOLVED", {
      customEndpoint: normalized,
      isCustom: true,
    });
    return normalized;
  }

  private getOpenAIEndpointCandidates(
    base: string
  ): Array<{ url: string; type: "responses" | "chat" }> {
    const lower = base.toLowerCase();

    if (lower.endsWith("/responses") || lower.endsWith("/chat/completions")) {
      const type = lower.endsWith("/responses") ? "responses" : "chat";
      return [{ url: base, type }];
    }

    const preference = this.getStoredOpenAiPreference(base);
    if (preference === "chat") {
      return [{ url: buildApiUrl(base, "/chat/completions"), type: "chat" }];
    }

    const candidates: Array<{ url: string; type: "responses" | "chat" }> = [
      { url: buildApiUrl(base, "/responses"), type: "responses" },
      { url: buildApiUrl(base, "/chat/completions"), type: "chat" },
    ];

    return candidates;
  }

  private getStoredOpenAiPreference(base: string): "responses" | "chat" | undefined {
    if (this.openAiEndpointPreference.has(base)) {
      return this.openAiEndpointPreference.get(base);
    }

    if (typeof window === "undefined" || !window.localStorage) {
      return undefined;
    }

    try {
      const raw = window.localStorage.getItem(ReasoningService.OPENAI_ENDPOINT_PREF_STORAGE_KEY);
      if (!raw) {
        return undefined;
      }
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) {
        return undefined;
      }
      const value = parsed[base];
      if (value === "responses" || value === "chat") {
        this.openAiEndpointPreference.set(base, value);
        return value;
      }
    } catch {
      return undefined;
    }

    return undefined;
  }

  private rememberOpenAiPreference(base: string, preference: "responses" | "chat"): void {
    this.openAiEndpointPreference.set(base, preference);

    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }

    try {
      const raw = window.localStorage.getItem(ReasoningService.OPENAI_ENDPOINT_PREF_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      const data = typeof parsed === "object" && parsed !== null ? parsed : {};
      data[base] = preference;
      window.localStorage.setItem(
        ReasoningService.OPENAI_ENDPOINT_PREF_STORAGE_KEY,
        JSON.stringify(data)
      );
    } catch {}
  }

  private async getApiKey(
    provider: "openai" | "anthropic" | "gemini" | "groq" | "custom"
  ): Promise<string> {
    if (provider === "custom") {
      let customKey = "";
      try {
        customKey = (await window.electronAPI?.getCustomReasoningKey?.()) || "";
      } catch (err) {
        logger.logReasoning("CUSTOM_KEY_IPC_FALLBACK", { error: (err as Error)?.message });
      }
      if (!customKey || !customKey.trim()) {
        customKey = window.localStorage?.getItem("customReasoningApiKey") || "";
      }
      const trimmedKey = customKey.trim();

      logger.logReasoning("CUSTOM_KEY_RETRIEVAL", {
        provider,
        hasKey: !!trimmedKey,
        keyLength: trimmedKey.length,
        keyPreview: trimmedKey ? "[configured]" : "none",
      });

      return trimmedKey;
    }

    let apiKey = this.apiKeyCache.get(provider);

    logger.logReasoning(`${provider.toUpperCase()}_KEY_RETRIEVAL`, {
      provider,
      fromCache: !!apiKey,
      cacheSize: this.apiKeyCache.size || 0,
    });

    if (!apiKey) {
      try {
        const keyGetters = {
          openai: () => window.electronAPI.getOpenAIKey(),
          anthropic: () => window.electronAPI.getAnthropicKey(),
          gemini: () => window.electronAPI.getGeminiKey(),
          groq: () => window.electronAPI.getGroqKey(),
        };
        apiKey = (await keyGetters[provider]()) ?? undefined;

        logger.logReasoning(`${provider.toUpperCase()}_KEY_FETCHED`, {
          provider,
          hasKey: !!apiKey,
          keyLength: apiKey?.length || 0,
          keyPreview: apiKey ? "[configured]" : "none",
        });

        if (apiKey) {
          this.apiKeyCache.set(provider, apiKey);
        }
      } catch (error) {
        logger.logReasoning(`${provider.toUpperCase()}_KEY_FETCH_ERROR`, {
          provider,
          error: (error as Error).message,
          stack: (error as Error).stack,
        });
      }
    }

    if (!apiKey) {
      const errorMsg = `${provider.charAt(0).toUpperCase() + provider.slice(1)} API key not configured`;
      logger.logReasoning(`${provider.toUpperCase()}_KEY_MISSING`, {
        provider,
        error: errorMsg,
      });
      throw new Error(errorMsg);
    }

    return apiKey;
  }

  private async callChatCompletionsApi(
    endpoint: string,
    apiKey: string,
    model: string,
    text: string,
    agentName: string | null,
    config: ReasoningConfig,
    providerName: string,
    abandon?: AbortSignal
  ): Promise<string> {
    const systemPrompt = this.getSystemPrompt(
      agentName,
      config.dictationMode,
      config.preferredLanguage,
      config.promptTemplate
    );
    const userPrompt = await this.buildUserPrompt(text, config);

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    const requestBody: any = {
      model,
      messages,
      temperature: config.temperature ?? 0.3,
      max_tokens:
        config.maxTokens ||
        Math.max(
          TOKEN_LIMITS.MIN_TOKENS,
          Math.min(
            Math.ceil(text.length * TOKEN_LIMITS.OUTPUT_TOKENS_PER_CHARACTER) +
              TOKEN_LIMITS.OUTPUT_TOKEN_HEADROOM,
            TOKEN_LIMITS.MAX_TOKENS
          )
        ),
    };

    // Groq exposes reasoning controls through its OpenAI-compatible chat API.
    const modelDef = getCloudModel(model);
    if (providerName.toLowerCase() === "groq") {
      if (modelDef?.reasoningEffort) {
        requestBody.reasoning_effort = modelDef.reasoningEffort;
      } else if (modelDef?.disableThinking) {
        requestBody.reasoning_effort = "none";
      }
    }

    logger.logReasoning(`${providerName.toUpperCase()}_REQUEST`, {
      endpoint,
      model,
      hasApiKey: !!apiKey,
      request: summarizeRequestBodyForLog(requestBody),
    });

    const requestTimeout = createRequestTimeout(config.timeoutMs, providerName, abandon);
    let response: any;
    try {
      response = await withRetry(
        async () => {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(requestBody),
            signal: requestTimeout.signal,
          });

          if (!res.ok) {
            const errorText = await res.text();
            let errorData: any = { error: res.statusText };

            try {
              errorData = JSON.parse(errorText);
            } catch {
              errorData = { error: errorText || res.statusText };
            }

            logger.logReasoning(`${providerName.toUpperCase()}_API_ERROR_DETAIL`, {
              status: res.status,
              statusText: res.statusText,
              error: summarizeApiErrorForLog(errorData),
              hasErrorMessage: !!(errorData.error?.message || errorData.message || errorData.error),
              responseBodyLength: errorText.length,
            });

            const errorMessage =
              errorData.error?.message ||
              errorData.message ||
              errorData.error ||
              `${providerName} API error: ${res.status}`;
            throw createApiError(errorMessage, res.status);
          }

          const jsonResponse = await res.json();

          logger.logReasoning(`${providerName.toUpperCase()}_RAW_RESPONSE`, {
            ...summarizeResponseForLog(jsonResponse),
          });

          return jsonResponse;
        },
        getApiRetryOptions(config, requestTimeout.signal)
      );
    } catch (error) {
      throw requestTimeout.timeoutError() || error;
    } finally {
      requestTimeout.clear();
    }

    if (!response.choices || !response.choices[0]) {
      logger.logReasoning(`${providerName.toUpperCase()}_RESPONSE_ERROR`, {
        model,
        response: summarizeResponseForLog(response),
        hasChoices: !!response.choices,
        choicesCount: response.choices?.length || 0,
      });
      throw new Error(`Invalid response structure from ${providerName} API`);
    }

    const choice = response.choices[0];
    if (choice.finish_reason === "length") {
      logger.logReasoning(`${providerName.toUpperCase()}_TRUNCATED`, {
        model,
        maxTokens: requestBody.max_tokens,
      });
      throw createTruncatedError(providerName);
    }
    const responseText = choice.message?.content?.trim() || "";

    if (!responseText) {
      logger.logReasoning(`${providerName.toUpperCase()}_EMPTY_RESPONSE`, {
        model,
        finishReason: choice.finish_reason,
        hasMessage: !!choice.message,
        response: summarizeResponseForLog({ choices: [choice] }),
      });
      throw new Error(`${providerName} returned empty response`);
    }

    logger.logReasoning(`${providerName.toUpperCase()}_RESPONSE`, {
      model,
      responseLength: responseText.length,
      tokensUsed: response.usage?.total_tokens || 0,
      success: true,
    });

    return responseText;
  }

  async processText(
    text: string,
    model: string = "",
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    const trimmedModel = model?.trim?.() || "";
    if (!trimmedModel) {
      throw new Error("No reasoning model selected");
    }
    const provider = getModelProvider(trimmedModel, this.getSelectedProvider());
    if (config.writingStyle === "coding") {
      config = { ...config, promptTemplate: config.promptTemplate ?? getCodingPrompt() };
    }
    // No request runs without a deadline. Dictation passes none, and a provider
    // that never answered used to hold the paste for good.
    const timeoutMs =
      normalizePositiveInteger(config.timeoutMs) ??
      this.getDictationTimeoutMs(text, provider, config.longSession === true);
    config = { ...config, timeoutMs };

    logger.logReasoning("PROVIDER_SELECTION", {
      model: trimmedModel,
      provider,
      agentName,
      hasConfig: Object.keys(config).length > 0,
      textLength: text.length,
      timestamp: new Date().toISOString(),
    });

    let request: object | null = null;
    try {
      let result: string;
      const startTime = Date.now();

      logger.logReasoning("ROUTING_TO_PROVIDER", {
        provider,
        model,
        timeoutMs,
      });

      // Claude Code runs in its own process and never took this place.
      if (provider !== "claude-code") {
        if (this.activeRequest) {
          throw new Error("Already processing a request");
        }
        request = {};
        this.activeRequest = request;
      }

      // A local model's timeout covers inference only; llama-server may have
      // to start first.
      const startupMs = provider === "local" ? DICTATION_CLEANUP_TIMEOUT.LOCAL_STARTUP_MS : 0;
      const abandon = new AbortController();
      result = await this.withDeadline(
        this.runProvider(provider, text, trimmedModel, model, agentName, config, abandon.signal),
        timeoutMs + startupMs + DEADLINE_GRACE_MS,
        () => abandon.abort()
      );

      // A coding prompt is dictated prose for another agent, not generated code.
      // Throw so the dictation pipeline preserves the original words on failure.
      if (config.writingStyle === "coding" && result.includes("```") && !text.includes("```")) {
        throw new Error(
          "The model wrote code instead of editing your words. Try another model or edit the coding instructions."
        );
      }

      // Short dictation is often a deliberate insertion into existing text.
      // Some providers return empty or punctuation-only output for fragments.
      // Keep the original instead of silently losing the user's word(s).
      if (isShortDictation(text) && !/[\p{L}\p{N}]/u.test(result)) {
        result = text.trim();
      }
      const processingTime = Date.now() - startTime;

      logger.logReasoning("PROVIDER_SUCCESS", {
        provider,
        model,
        processingTimeMs: processingTime,
        resultLength: result.length,
        resultPreview: result.substring(0, 100) + (result.length > 100 ? "..." : ""),
      });

      return result;
    } catch (error) {
      logger.logReasoning("PROVIDER_ERROR", {
        provider,
        model,
        error: (error as Error).message,
        stack: (error as Error).stack,
      });
      throw error;
    } finally {
      if (request && this.activeRequest === request) {
        this.activeRequest = null;
      }
    }
  }

  /**
   * How long AI cleanup may take when the caller sets no limit, as in
   * dictation. Grows with the transcript, and slower for a custom endpoint,
   * which is often a model on the user's own PC. A local model keeps
   * llama-server's own inference limit.
   */
  private getDictationTimeoutMs(text: string, provider: string, longSession: boolean): number {
    const limits = DICTATION_CLEANUP_TIMEOUT;
    if (provider === "local") return limits.LOCAL_MS;
    if (provider === "custom") {
      return Math.min(
        limits.CUSTOM_BASE_MS + text.length * limits.CUSTOM_PER_CHARACTER_MS,
        longSession ? limits.LONG_SESSION_MAX_MS : limits.CUSTOM_MAX_MS
      );
    }
    return Math.min(
      limits.BASE_MS + text.length * limits.PER_CHARACTER_MS,
      longSession ? limits.LONG_SESSION_MAX_MS : limits.MAX_MS
    );
  }

  /**
   * Each provider stops its own request at config.timeoutMs. This outer
   * deadline catches a call that never settles anyway, such as an IPC reply
   * that never comes, so the next dictation is not held up behind it.
   */
  private async withDeadline<T>(
    work: Promise<T>,
    durationMs: number,
    onExpire: () => void
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onExpire();
        reject(new Error(`AI cleanup timed out after ${durationMs} ms`));
      }, durationMs);
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async runProvider(
    provider: string,
    text: string,
    trimmedModel: string,
    model: string,
    agentName: string | null,
    config: ReasoningConfig,
    abandon: AbortSignal
  ): Promise<string> {
    let result: string;
    switch (provider) {
      case "claude-code": {
        const bridge = window.electronAPI?.enhanceWithClaudeCode;
        if (!bridge) throw new Error("Claude Code enhancement is unavailable. Restart the app.");
        const reply = await bridge(
          await this.buildUserPrompt(text, config),
          this.getSystemPrompt(
            agentName,
            config.dictationMode,
            config.preferredLanguage,
            config.promptTemplate
          )
        );
        if (!reply.ok || !reply.text?.trim()) {
          throw new Error(reply.message || "Claude Code did not return enhanced text.");
        }
        result = reply.text.trim();
        break;
      }
      case "openai":
      case "custom":
        result = await this.processWithOpenAI(
          text,
          trimmedModel,
          agentName,
          config,
          provider === "custom",
          abandon
        );
        break;
      case "anthropic":
        result = await this.processWithAnthropic(text, trimmedModel, agentName, config);
        break;
      case "local":
        result = await this.processWithLocal(text, trimmedModel, agentName, config);
        break;
      case "gemini":
        result = await this.processWithGemini(text, trimmedModel, agentName, config, abandon);
        break;
      case "groq":
        result = await this.processWithGroq(text, model, agentName, config, abandon);
        break;
      default:
        throw new Error(`Unsupported reasoning provider: ${provider}`);
    }
    return result;
  }

  private async processWithOpenAI(
    text: string,
    model: string,
    agentName: string | null = null,
    config: ReasoningConfig = {},
    // Decided once by processText. Reading the setting again after the awaits
    // below could pair the OpenAI key with the custom address, or the reverse.
    isCustomProvider = false,
    abandon?: AbortSignal
  ): Promise<string> {
    logger.logReasoning("OPENAI_START", {
      model,
      agentName,
      isCustomProvider,
      hasApiKey: false, // Will update after fetching
    });

    const openAiBase = this.getConfiguredOpenAIBase(isCustomProvider);
    const apiKey = await this.getApiKey(isCustomProvider ? "custom" : "openai");

    logger.logReasoning("OPENAI_API_KEY", {
      hasApiKey: !!apiKey,
      keyLength: apiKey?.length || 0,
    });

    try {
      const systemPrompt = this.getSystemPrompt(
        agentName,
        config.dictationMode,
        config.preferredLanguage,
        config.promptTemplate
      );
      const userPrompt = await this.buildUserPrompt(text, config);

      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ];

      const isOlderModel = model && (model.startsWith("gpt-4") || model.startsWith("gpt-3"));

      const endpointCandidates = this.getOpenAIEndpointCandidates(openAiBase);
      const isCustomEndpoint = openAiBase !== API_ENDPOINTS.OPENAI_BASE;

      logger.logReasoning("OPENAI_ENDPOINTS", {
        base: openAiBase,
        isCustomEndpoint,
        candidates: endpointCandidates.map((candidate) => candidate.url),
        preference: this.getStoredOpenAiPreference(openAiBase) || null,
      });

      if (isCustomEndpoint) {
        logger.logReasoning("CUSTOM_TEXT_CLEANUP_REQUEST", {
          customBase: openAiBase,
          model,
          textLength: text.length,
          hasApiKey: !!apiKey,
          apiKeyPreview: apiKey ? "[configured]" : "(none)",
        });
      }

      const requestTimeout = createRequestTimeout(config.timeoutMs, "OpenAI", abandon);
      let response: any;
      try {
        response = await withRetry(
          async () => {
            let lastError: Error | null = null;

            for (const { url: endpoint, type } of endpointCandidates) {
              try {
                const requestBody: any = { model };

                if (type === "responses") {
                  requestBody.input = messages;
                  requestBody.store = false;
                } else {
                  requestBody.messages = messages;
                  if (isOlderModel) {
                    requestBody.temperature = config.temperature || 0.3;
                  }
                }

                const modelDef = getCloudModel(model);
                if (!isCustomProvider && modelDef?.reasoningEffort) {
                  if (type === "responses") {
                    requestBody.reasoning = { effort: modelDef.reasoningEffort };
                  } else {
                    requestBody.reasoning_effort = modelDef.reasoningEffort;
                  }
                }

                const res = await fetch(endpoint, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    // A local server such as Ollama takes no key.
                    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                  },
                  body: JSON.stringify(requestBody),
                  signal: requestTimeout.signal,
                });

                if (!res.ok) {
                  const errorData = await res.json().catch(() => ({ error: res.statusText }));
                  const errorMessage = truncateErrorMessage(
                    errorData.error?.message ||
                      errorData.message ||
                      `OpenAI API error: ${res.status}`
                  );

                  const isUnsupportedEndpoint =
                    (res.status === 404 || res.status === 405) && type === "responses";

                  if (isUnsupportedEndpoint) {
                    lastError = new Error(errorMessage);
                    this.rememberOpenAiPreference(openAiBase, "chat");
                    logger.logReasoning("OPENAI_ENDPOINT_FALLBACK", {
                      attemptedEndpoint: endpoint,
                      error: errorMessage,
                    });
                    continue;
                  }

                  throw createApiError(errorMessage, res.status);
                }

                this.rememberOpenAiPreference(openAiBase, type);
                return res.json();
              } catch (error) {
                lastError = error as Error;
                if (type === "responses") {
                  logger.logReasoning("OPENAI_ENDPOINT_FALLBACK", {
                    attemptedEndpoint: endpoint,
                    error: truncateErrorMessage((error as Error).message),
                  });
                  continue;
                }
                throw error;
              }
            }

            throw lastError || new Error("No OpenAI endpoint responded");
          },
          getApiRetryOptions(config, requestTimeout.signal)
        );
      } catch (error) {
        throw requestTimeout.timeoutError() || error;
      } finally {
        requestTimeout.clear();
      }

      const isResponsesApi = Array.isArray(response?.output);
      const isChatCompletions = Array.isArray(response?.choices);

      logger.logReasoning("OPENAI_RAW_RESPONSE", {
        model,
        format: isResponsesApi ? "responses" : isChatCompletions ? "chat_completions" : "unknown",
        hasOutput: isResponsesApi,
        outputLength: isResponsesApi ? response.output.length : 0,
        outputTypes: isResponsesApi ? response.output.map((item: any) => item.type) : undefined,
        hasChoices: isChatCompletions,
        choicesLength: isChatCompletions ? response.choices.length : 0,
        usage: response.usage,
      });

      const isTruncated =
        response?.status === "incomplete" ||
        (isChatCompletions && response.choices.some((c: any) => c?.finish_reason === "length"));
      if (isTruncated) {
        logger.logReasoning("OPENAI_TRUNCATED", {
          model,
          status: response?.status,
          reason: response?.incomplete_details?.reason,
        });
        throw createTruncatedError(isCustomProvider ? "The custom endpoint" : "OpenAI");
      }

      let responseText = "";

      if (isResponsesApi) {
        for (const item of response.output) {
          if (item.type === "message" && item.content) {
            for (const content of item.content) {
              if (content.type === "output_text" && content.text) {
                responseText = content.text.trim();
                break;
              }
            }
            if (responseText) break;
          }
        }
      }

      if (!responseText && typeof response?.output_text === "string") {
        responseText = response.output_text.trim();
      }

      if (!responseText && isChatCompletions) {
        for (const choice of response.choices) {
          const message = choice?.message ?? choice?.delta;
          const content = message?.content;

          if (typeof content === "string" && content.trim()) {
            responseText = content.trim();
            break;
          }

          if (Array.isArray(content)) {
            for (const part of content) {
              if (typeof part?.text === "string" && part.text.trim()) {
                responseText = part.text.trim();
                break;
              }
            }
          }

          if (responseText) break;

          if (typeof choice?.text === "string" && choice.text.trim()) {
            responseText = choice.text.trim();
            break;
          }
        }
      }

      logger.logReasoning("OPENAI_RESPONSE", {
        model,
        responseLength: responseText.length,
        tokensUsed: response.usage?.total_tokens || 0,
        success: true,
        isEmpty: responseText.length === 0,
      });

      if (!responseText) {
        logger.logReasoning("OPENAI_EMPTY_RESPONSE_FALLBACK", {
          model,
          originalTextLength: text.length,
          reason: "Empty response from API",
        });
        return text;
      }

      return responseText;
    } catch (error) {
      logger.logReasoning("OPENAI_ERROR", {
        model,
        error: (error as Error).message,
        errorType: (error as Error).name,
      });
      throw error;
    }
  }

  private async processWithAnthropic(
    text: string,
    model: string,
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    logger.logReasoning("ANTHROPIC_START", {
      model,
      agentName,
      environment: typeof window !== "undefined" ? "browser" : "node",
    });

    if (typeof window !== "undefined" && window.electronAPI) {
      const startTime = Date.now();

      const customSystemPrompt = this.getSystemPrompt(
        agentName,
        config.dictationMode,
        config.preferredLanguage,
        config.promptTemplate
      );
      logger.logReasoning("ANTHROPIC_IPC_CALL", {
        model,
        textLength: text.length,
      });

      const result = await window.electronAPI.processAnthropicReasoning(text, model, agentName, {
        ...config,
        customSystemPrompt,
      });

      const processingTime = Date.now() - startTime;

      if (result.success) {
        logger.logReasoning("ANTHROPIC_SUCCESS", {
          model,
          processingTimeMs: processingTime,
          resultLength: result.text.length,
        });
        return result.text;
      } else {
        logger.logReasoning("ANTHROPIC_ERROR", {
          model,
          processingTimeMs: processingTime,
          error: result.error,
        });
        throw new Error(result.error);
      }
    } else {
      logger.logReasoning("ANTHROPIC_UNAVAILABLE", {
        reason: "Not in Electron environment",
      });
      throw new Error("Anthropic reasoning is not available in this environment");
    }
  }

  private async processWithLocal(
    text: string,
    model: string,
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    logger.logReasoning("LOCAL_START", {
      model,
      agentName,
      environment: typeof window !== "undefined" ? "browser" : "node",
    });

    if (typeof window !== "undefined" && window.electronAPI) {
      const startTime = Date.now();

      const customSystemPrompt = this.getSystemPrompt(
        agentName,
        config.dictationMode,
        config.preferredLanguage,
        config.promptTemplate
      );
      logger.logReasoning("LOCAL_IPC_CALL", {
        model,
        textLength: text.length,
      });

      const result = await window.electronAPI.processLocalReasoning(text, model, agentName, {
        ...config,
        customSystemPrompt,
      });

      const processingTime = Date.now() - startTime;

      if (result.success) {
        logger.logReasoning("LOCAL_SUCCESS", {
          model,
          processingTimeMs: processingTime,
          resultLength: result.text.length,
        });
        return result.text;
      } else {
        logger.logReasoning("LOCAL_ERROR", {
          model,
          processingTimeMs: processingTime,
          error: result.error,
        });
        throw new Error(result.error);
      }
    } else {
      logger.logReasoning("LOCAL_UNAVAILABLE", {
        reason: "Not in Electron environment",
      });
      throw new Error("Local reasoning is not available in this environment");
    }
  }

  private async processWithGemini(
    text: string,
    model: string,
    agentName: string | null = null,
    config: ReasoningConfig = {},
    abandon?: AbortSignal
  ): Promise<string> {
    logger.logReasoning("GEMINI_START", {
      model,
      agentName,
      hasApiKey: false,
    });

    const apiKey = await this.getApiKey("gemini");

    logger.logReasoning("GEMINI_API_KEY", {
      hasApiKey: !!apiKey,
      keyLength: apiKey?.length || 0,
    });

    try {
      const systemPrompt = this.getSystemPrompt(
        agentName,
        config.dictationMode,
        config.preferredLanguage,
        config.promptTemplate
      );
      const userPrompt = await this.buildUserPrompt(text, config);

      const requestBody: any = {
        contents: [
          {
            parts: [
              {
                text: `${systemPrompt}\n\n${userPrompt}`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: config.temperature || 0.3,
          maxOutputTokens:
            config.maxTokens ||
            this.calculateMaxTokens(
              text.length,
              TOKEN_LIMITS.MIN_TOKENS_GEMINI,
              TOKEN_LIMITS.MAX_TOKENS_GEMINI,
              TOKEN_LIMITS.TOKEN_MULTIPLIER
            ),
        },
      };

      const modelDef = getCloudModel(model);
      if (modelDef?.thinkingLevel) {
        requestBody.generationConfig.thinkingConfig = {
          thinkingLevel: modelDef.thinkingLevel,
        };
      }

      let response: any;
      const requestTimeout = createRequestTimeout(config.timeoutMs, "Gemini", abandon);
      try {
        response = await withRetry(
          async () => {
            logger.logReasoning("GEMINI_REQUEST", {
              endpoint: `${API_ENDPOINTS.GEMINI}/models/${model}:generateContent`,
              model,
              hasApiKey: !!apiKey,
              request: summarizeRequestBodyForLog(requestBody),
            });

            const res = await fetch(`${API_ENDPOINTS.GEMINI}/models/${model}:generateContent`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": apiKey,
              },
              body: JSON.stringify(requestBody),
              signal: requestTimeout.signal,
            });

            if (!res.ok) {
              const errorText = await res.text();
              let errorData: any = { error: res.statusText };

              try {
                errorData = JSON.parse(errorText);
              } catch {
                errorData = { error: errorText || res.statusText };
              }

              logger.logReasoning("GEMINI_API_ERROR_DETAIL", {
                status: res.status,
                statusText: res.statusText,
                error: summarizeApiErrorForLog(errorData),
                hasErrorMessage: !!(
                  errorData.error?.message ||
                  errorData.message ||
                  errorData.error
                ),
                responseBodyLength: errorText.length,
              });

              const errorMessage =
                errorData.error?.message ||
                errorData.message ||
                errorData.error ||
                `Gemini API error: ${res.status}`;
              throw createApiError(errorMessage, res.status);
            }

            const jsonResponse = await res.json();

            logger.logReasoning("GEMINI_RAW_RESPONSE", {
              ...summarizeResponseForLog(jsonResponse),
            });

            return jsonResponse;
          },
          getApiRetryOptions(config, requestTimeout.signal)
        );
      } catch (fetchError) {
        logger.logReasoning("GEMINI_FETCH_ERROR", {
          error: (fetchError as Error).message,
          errorType: (fetchError as Error).name,
        });
        throw requestTimeout.timeoutError() || fetchError;
      } finally {
        requestTimeout.clear();
      }

      if (!response.candidates || !response.candidates[0]) {
        logger.logReasoning("GEMINI_RESPONSE_ERROR", {
          model,
          response: summarizeResponseForLog(response),
          hasCandidate: !!response.candidates,
          candidateCount: response.candidates?.length || 0,
        });
        throw new Error("Invalid response structure from Gemini API");
      }

      const candidate = response.candidates[0];
      if (candidate.finishReason === "MAX_TOKENS") {
        logger.logReasoning("GEMINI_TRUNCATED", {
          model,
          maxOutputTokens: requestBody.generationConfig.maxOutputTokens,
          hasText: !!candidate.content?.parts?.[0]?.text,
        });
        throw createTruncatedError("Gemini");
      }
      if (!candidate.content?.parts?.[0]?.text) {
        logger.logReasoning("GEMINI_EMPTY_RESPONSE", {
          model,
          finishReason: candidate.finishReason,
          hasContent: !!candidate.content,
          hasParts: !!candidate.content?.parts,
          response: summarizeResponseForLog({ candidates: [candidate] }),
        });

        throw new Error("Gemini returned empty response");
      }

      const responseText = candidate.content.parts[0].text.trim();

      logger.logReasoning("GEMINI_RESPONSE", {
        model,
        responseLength: responseText.length,
        tokensUsed: response.usageMetadata?.totalTokenCount || 0,
        success: true,
      });

      return responseText;
    } catch (error) {
      logger.logReasoning("GEMINI_ERROR", {
        model,
        error: (error as Error).message,
        errorType: (error as Error).name,
      });
      throw error;
    }
  }

  private async processWithGroq(
    text: string,
    model: string,
    agentName: string | null = null,
    config: ReasoningConfig = {},
    abandon?: AbortSignal
  ): Promise<string> {
    logger.logReasoning("GROQ_START", { model, agentName });

    const apiKey = await this.getApiKey("groq");
    try {
      const endpoint = buildApiUrl(API_ENDPOINTS.GROQ_BASE, "/chat/completions");
      return await this.callChatCompletionsApi(
        endpoint,
        apiKey,
        model,
        text,
        agentName,
        config,
        "Groq",
        abandon
      );
    } catch (error) {
      logger.logReasoning("GROQ_ERROR", {
        model,
        error: (error as Error).message,
        errorType: (error as Error).name,
      });
      throw error;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      // A custom endpoint needs no key, and an address it can't use fails the
      // request itself with the reason, rather than skipping cleanup silently.
      if (this.getSelectedProvider() === "custom") return true;
      if (window.localStorage?.getItem("reasoningModel") === "claude-code") {
        return Boolean((await window.electronAPI?.agentModeRewriteStatus?.())?.available);
      }
      const openaiKey = await window.electronAPI?.getOpenAIKey?.();
      const anthropicKey = await window.electronAPI?.getAnthropicKey?.();
      const geminiKey = await window.electronAPI?.getGeminiKey?.();
      const groqKey = await window.electronAPI?.getGroqKey?.();
      const localAvailable = await window.electronAPI?.checkLocalReasoningAvailable?.();

      logger.logReasoning("API_KEY_CHECK", {
        hasOpenAI: !!openaiKey,
        hasAnthropic: !!anthropicKey,
        hasGemini: !!geminiKey,
        hasGroq: !!groqKey,
        hasLocal: !!localAvailable,
      });

      return !!(openaiKey || anthropicKey || geminiKey || groqKey || localAvailable);
    } catch (error) {
      logger.logReasoning("API_KEY_CHECK_ERROR", {
        error: (error as Error).message,
        stack: (error as Error).stack,
        name: (error as Error).name,
      });
      return false;
    }
  }

  clearApiKeyCache(provider?: "openai" | "anthropic" | "gemini" | "groq" | "custom"): void {
    if (provider) {
      if (provider !== "custom") {
        this.apiKeyCache.delete(provider);
      }
      logger.logReasoning("API_KEY_CACHE_CLEARED", { provider });
    } else {
      this.apiKeyCache.clear();
      logger.logReasoning("API_KEY_CACHE_CLEARED", { provider: "all" });
    }
  }

  destroy(): void {
    if (this.cacheCleanupStop) {
      this.cacheCleanupStop();
    }
  }
}

export default new ReasoningService();
