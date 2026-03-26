import { getSystemPrompt } from "../config/prompts";

export interface ReasoningConfig {
  maxTokens?: number;
  temperature?: number;
  contextSize?: number;
  /** Active dictation mode set by an Action Engine "dictation-mode" action. */
  dictationMode?: string;
  /** User's preferred output language (BCP-47 code, e.g. "en", "fr"). Null/undefined/"auto" = no constraint. */
  preferredLanguage?: string | null;
  /**
   * Pre-fetched Smart Context object from the shared context pipeline.
   * When present, used instead of re-capturing context inside ReasoningService.
   */
  smartContext?: Record<string, unknown> | null;
}

export abstract class BaseReasoningService {
  protected isProcessing = false;

  protected getCustomDictionary(): string[] {
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

  protected getSystemPrompt(
    agentName: string | null,
    dictationMode?: string,
    preferredLanguage?: string | null
  ): string {
    return getSystemPrompt(agentName, this.getCustomDictionary(), dictationMode, preferredLanguage);
  }

  protected calculateMaxTokens(
    textLength: number,
    minTokens = 100,
    maxTokens = 2048,
    multiplier = 2
  ): number {
    return Math.max(minTokens, Math.min(textLength * multiplier, maxTokens));
  }

  abstract isAvailable(): Promise<boolean>;

  abstract processText(
    text: string,
    modelId: string,
    agentName?: string | null,
    config?: ReasoningConfig
  ): Promise<string>;
}
