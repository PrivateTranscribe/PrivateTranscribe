import modelDataRaw from "./modelRegistryData.json";

export interface ModelDefinition {
  id: string;
  name: string;
  size: string;
  sizeBytes: number;
  description: string;
  fileName: string;
  quantization: string;
  contextLength: number;
  hfRepo: string;
  hfRevision?: string;
  sha256?: string;
  recommended?: boolean;
}

export interface LocalProviderData {
  id: string;
  name: string;
  baseUrl: string;
  promptTemplate: string;
  models: ModelDefinition[];
}

export interface ModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  models: ModelDefinition[];
  formatPrompt(text: string, systemPrompt: string): string;
  getDownloadUrl(model: ModelDefinition): string;
}

export interface CloudModelDefinition {
  id: string;
  name: string;
  description: string;
  disableThinking?: boolean;
  recommended?: boolean;
  deprecated?: boolean;
  replacementId?: string;
  reasoningEffort?: "none" | "low";
  thinkingLevel?: "minimal" | "low";
}

export interface CloudProviderData {
  id: string;
  name: string;
  models: CloudModelDefinition[];
}

export interface TranscriptionModelDefinition {
  id: string;
  name: string;
  description: string;
  recommended?: boolean;
}

export interface TranscriptionProviderData {
  id: string;
  name: string;
  baseUrl: string;
  models: TranscriptionModelDefinition[];
}

export interface WhisperModelInfo {
  name: string;
  description: string;
  size: string;
  sizeMb: number;
  fileName: string;
  downloadUrl: string;
  recommended?: boolean;
}

export interface WhisperModelConfig {
  url: string;
  size: number;
  fileName: string;
}

export type WhisperModelsMap = Record<string, WhisperModelInfo>;

export interface ParakeetModelInfo {
  name: string;
  description: string;
  size: string;
  sizeMb: number;
  language: string;
  supportedLanguages: string[];
  recommended?: boolean;
  downloadUrl: string;
  extractDir: string;
}

export type ParakeetModelsMap = Record<string, ParakeetModelInfo>;

/** One file of a Kokoro model, laid out under the transformers cache dir. */
export interface KokoroModelFile {
  /** Path relative to the repo root inside the cache, e.g. "onnx/model.onnx". */
  relPath: string;
  url: string;
  /** Expected size on disk, used to tell a complete file from a truncated one. */
  bytes: number;
}

export interface KokoroModelInfo {
  name: string;
  description: string;
  /** HuggingFace repo id — also the cache subdirectory the engine loads from. */
  hfRepo: string;
  sizeMb: number;
  files: KokoroModelFile[];
}

export type KokoroModelsMap = Record<string, KokoroModelInfo>;

interface ModelRegistryData {
  parakeetModels: ParakeetModelsMap;
  kokoroModels: KokoroModelsMap;
  whisperModels: WhisperModelsMap;
  transcriptionProviders: TranscriptionProviderData[];
  cloudProviders: CloudProviderData[];
  localProviders: LocalProviderData[];
}

const modelData: ModelRegistryData = modelDataRaw as ModelRegistryData;

function createPromptFormatter(template: string): (text: string, systemPrompt: string) => string {
  return (text: string, systemPrompt: string) => {
    return template.replace("{system}", systemPrompt).replace("{user}", text);
  };
}

class ModelRegistry {
  private static instance: ModelRegistry;
  private providers = new Map<string, ModelProvider>();

  private constructor() {
    this.registerProvidersFromData();
  }

  static getInstance(): ModelRegistry {
    if (!ModelRegistry.instance) {
      ModelRegistry.instance = new ModelRegistry();
    }
    return ModelRegistry.instance;
  }

  registerProvider(provider: ModelProvider) {
    this.providers.set(provider.id, provider);
  }

  getProvider(providerId: string): ModelProvider | undefined {
    return this.providers.get(providerId);
  }

  getAllProviders(): ModelProvider[] {
    return Array.from(this.providers.values());
  }

  getModel(modelId: string): { model: ModelDefinition; provider: ModelProvider } | undefined {
    for (const provider of this.providers.values()) {
      const model = provider.models.find((m) => m.id === modelId);
      if (model) {
        return { model, provider };
      }
    }
    return undefined;
  }

  getAllModels(): Array<ModelDefinition & { providerId: string }> {
    const models: Array<ModelDefinition & { providerId: string }> = [];
    for (const provider of this.providers.values()) {
      for (const model of provider.models) {
        models.push({ ...model, providerId: provider.id });
      }
    }
    return models;
  }

  getCloudProviders(): CloudProviderData[] {
    return modelData.cloudProviders;
  }

  getTranscriptionProviders(): TranscriptionProviderData[] {
    return modelData.transcriptionProviders;
  }

  private registerProvidersFromData() {
    const localProviders = modelData.localProviders;

    for (const providerData of localProviders) {
      const formatPrompt = createPromptFormatter(providerData.promptTemplate);

      this.registerProvider({
        id: providerData.id,
        name: providerData.name,
        baseUrl: providerData.baseUrl,
        models: providerData.models,
        formatPrompt,
        getDownloadUrl(model: ModelDefinition): string {
          const revision = model.hfRevision || "main";
          return `${providerData.baseUrl}/${model.hfRepo}/resolve/${revision}/${model.fileName}`;
        },
      });
    }
  }
}

export const modelRegistry = ModelRegistry.getInstance();

export interface ReasoningModel {
  value: string;
  label: string;
  description: string;
  recommended?: boolean;
  deprecated?: boolean;
  replacementId?: string;
  reasoningEffort?: "none" | "low";
  thinkingLevel?: "minimal" | "low";
}

export interface ReasoningProvider {
  name: string;
  models: ReasoningModel[];
}

export type ReasoningProviders = Record<string, ReasoningProvider>;

function buildReasoningProviders(): ReasoningProviders {
  const providers: ReasoningProviders = {};

  for (const cloudProvider of modelRegistry.getCloudProviders()) {
    providers[cloudProvider.id] = {
      name: cloudProvider.name,
      models: cloudProvider.models.map((m) => ({
        value: m.id,
        label: m.name,
        description: m.description,
        recommended: m.recommended,
        deprecated: m.deprecated,
        replacementId: m.replacementId,
        reasoningEffort: m.reasoningEffort,
        thinkingLevel: m.thinkingLevel,
      })),
    };
  }

  providers.local = {
    name: "Local AI",
    models: modelRegistry.getAllModels().map((model) => ({
      value: model.id,
      label: model.name,
      description: `${model.description} (${model.size})`,
    })),
  };

  return providers;
}

export const REASONING_PROVIDERS = buildReasoningProviders();

export interface ReasoningModelWithProvider extends ReasoningModel {
  provider: string;
  fullLabel: string;
}

export function getAllReasoningModels(): ReasoningModelWithProvider[] {
  return Object.entries(REASONING_PROVIDERS).flatMap(([providerId, provider]) =>
    provider.models.map((model) => ({
      ...model,
      provider: providerId,
      fullLabel: `${provider.name} ${model.label}`,
    }))
  );
}

export function getReasoningModelLabel(modelId: string): string {
  const model = getAllReasoningModels().find((m) => m.value === modelId);
  return model?.fullLabel || modelId;
}

export function getModelProvider(modelId: string): string {
  const model = getAllReasoningModels().find((m) => m.value === modelId);

  if (!model) {
    if (modelId.includes("claude")) return "anthropic";
    if (modelId.includes("gemini") && !modelId.includes("gemma")) return "gemini";
    if (
      (modelId.includes("gpt-4") || modelId.includes("gpt-5") || modelId.includes("gpt-6")) &&
      !modelId.includes("gpt-oss")
    )
      return "openai";
    if (modelId.includes("qwen/") || modelId.includes("openai/")) return "groq";
    if (modelId.includes("qwen") || modelId.includes("gpt-oss-20b-mxfp4")) return "local";
  }

  return model?.provider || "openai";
}

export function getTranscriptionProviders(): TranscriptionProviderData[] {
  return modelRegistry.getTranscriptionProviders();
}

export function getTranscriptionProvider(
  providerId: string
): TranscriptionProviderData | undefined {
  return getTranscriptionProviders().find((p) => p.id === providerId);
}

export function getTranscriptionModels(providerId: string): TranscriptionModelDefinition[] {
  const provider = getTranscriptionProvider(providerId);
  return provider?.models || [];
}

export function getDefaultTranscriptionModel(providerId: string): string {
  const models = getTranscriptionModels(providerId);
  return models[0]?.id || "gpt-transcribe";
}

export function getWhisperModels(): WhisperModelsMap {
  return modelData.whisperModels;
}

export function getWhisperModelInfo(modelId: string): WhisperModelInfo | undefined {
  return modelData.whisperModels[modelId];
}

export const WHISPER_MODEL_INFO = modelData.whisperModels;

/**
 * Sort order for whisper models in pickers. The registry JSON key order is
 * historical and reads as random in the UI, so lists sort explicitly:
 * the recommended model first, then smallest to largest download.
 */
export function compareWhisperModelsForDisplay(
  aId: string,
  bId: string,
  recommendedId?: string | null
): number {
  const a = modelData.whisperModels[aId];
  const b = modelData.whisperModels[bId];

  const rank = (id: string, info?: WhisperModelInfo): number => {
    if (recommendedId) return id === recommendedId ? 0 : 1;
    return info?.recommended ? 0 : 1;
  };

  const rankDiff = rank(aId, a) - rank(bId, b);
  if (rankDiff !== 0) return rankDiff;

  const sizeDiff = (a?.sizeMb ?? Number.MAX_SAFE_INTEGER) - (b?.sizeMb ?? Number.MAX_SAFE_INTEGER);
  if (sizeDiff !== 0) return sizeDiff;

  return (a?.name ?? aId).localeCompare(b?.name ?? bId);
}

export function getCloudModel(modelId: string): CloudModelDefinition | undefined {
  for (const provider of modelData.cloudProviders) {
    const model = provider.models.find((m) => m.id === modelId);
    if (model) return model;
  }
  return undefined;
}

export function getParakeetModels(): ParakeetModelsMap {
  return modelData.parakeetModels;
}

export function getParakeetModelInfo(modelId: string): ParakeetModelInfo | undefined {
  return modelData.parakeetModels[modelId];
}

export const PARAKEET_MODEL_INFO = modelData.parakeetModels;

export function getKokoroModels(): KokoroModelsMap {
  return modelData.kokoroModels;
}

export function getKokoroModelInfo(modelId: string): KokoroModelInfo | undefined {
  return modelData.kokoroModels[modelId];
}

export const KOKORO_MODEL_INFO = modelData.kokoroModels;

export function getWhisperModelConfig(modelId: string): WhisperModelConfig | null {
  const modelInfo = modelData.whisperModels[modelId];
  if (!modelInfo) return null;
  return {
    url: modelInfo.downloadUrl,
    size: modelInfo.sizeMb * 1_000_000,
    fileName: modelInfo.fileName,
  };
}

export function getValidWhisperModelNames(): string[] {
  return Object.keys(modelData.whisperModels);
}
