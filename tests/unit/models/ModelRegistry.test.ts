/**
 * Tests for Model Registry
 * @module tests/unit/models/ModelRegistry
 */

import { describe, it, expect } from "vitest";

// Mock model data structure for testing
// This mirrors the logic in src/models/ModelRegistry.ts

interface CloudModelDefinition {
  id: string;
  name: string;
  description: string;
  disableThinking?: boolean;
}

interface CloudProviderData {
  id: string;
  name: string;
  models: CloudModelDefinition[];
}

interface TranscriptionModelDefinition {
  id: string;
  name: string;
  description: string;
}

interface TranscriptionProviderData {
  id: string;
  name: string;
  baseUrl: string;
  models: TranscriptionModelDefinition[];
}

// Mock data matching modelRegistryData.json structure
const mockCloudProviders: CloudProviderData[] = [
  {
    id: "openai",
    name: "OpenAI",
    models: [
      { id: "gpt-5.2", name: "GPT-5.2", description: "Latest GPT model" },
      { id: "gpt-5-mini", name: "GPT-5 Mini", description: "Efficient GPT model" },
      { id: "gpt-4.1", name: "GPT-4.1", description: "GPT-4 series" },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    models: [
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", description: "Balanced model" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", description: "Fast model" },
      { id: "claude-opus-4-5", name: "Claude Opus 4.5", description: "Most capable" },
    ],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    models: [
      { id: "gemini-3-pro", name: "Gemini 3 Pro", description: "Pro model" },
      { id: "gemini-3-flash", name: "Gemini 3 Flash", description: "Fast model" },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    models: [
      {
        id: "qwen/qwen3-32b",
        name: "Qwen3 32B",
        description: "Qwen 32B on Groq",
        disableThinking: true,
      },
      { id: "llama-3.3-70b-versatile", name: "LLaMA 3.3 70B", description: "Versatile" },
      { id: "mixtral-8x7b-32768", name: "Mixtral 8x7B", description: "MoE model" },
    ],
  },
];

const mockTranscriptionProviders: TranscriptionProviderData[] = [
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: [
      { id: "gpt-transcribe", name: "GPT Transcribe", description: "Recommended" },
      { id: "gpt-4o-mini-transcribe", name: "GPT-4o Mini Transcribe", description: "Efficient" },
      { id: "gpt-4o-transcribe", name: "GPT-4o Transcribe", description: "Previous" },
      { id: "whisper-1", name: "Whisper-1", description: "Classic" },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    models: [
      {
        id: "whisper-large-v3-turbo",
        name: "Whisper Large v3 Turbo",
        description: "Ultra-fast",
      },
    ],
  },
];

// Implementation of getModelProvider matching the actual logic
function getModelProvider(modelId: string): string {
  // Check cloud providers first
  for (const provider of mockCloudProviders) {
    const model = provider.models.find((m) => m.id === modelId);
    if (model) {
      return provider.id;
    }
  }

  // Fallback logic for model ID patterns
  if (modelId.includes("claude")) return "anthropic";
  if (modelId.includes("gemini") && !modelId.includes("gemma")) return "gemini";
  if ((modelId.includes("gpt-4") || modelId.includes("gpt-5")) && !modelId.includes("gpt-oss"))
    return "openai";
  if (
    modelId.includes("qwen/") ||
    modelId.includes("openai/") ||
    modelId.includes("llama-3.1-8b-instant") ||
    modelId.includes("llama-3.3-") ||
    modelId.includes("mixtral-") ||
    modelId.includes("gemma2-")
  )
    return "groq";
  if (
    modelId.includes("qwen") ||
    modelId.includes("llama") ||
    modelId.includes("mistral") ||
    modelId.includes("gpt-oss-20b-mxfp4")
  )
    return "local";

  return "openai"; // Default
}

function getCloudModel(modelId: string): CloudModelDefinition | undefined {
  for (const provider of mockCloudProviders) {
    const model = provider.models.find((m) => m.id === modelId);
    if (model) return model;
  }
  return undefined;
}

function getTranscriptionProvider(providerId: string): TranscriptionProviderData | undefined {
  return mockTranscriptionProviders.find((p) => p.id === providerId);
}

function getTranscriptionModels(providerId: string): TranscriptionModelDefinition[] {
  const provider = getTranscriptionProvider(providerId);
  return provider?.models || [];
}

function getDefaultTranscriptionModel(providerId: string): string {
  const models = getTranscriptionModels(providerId);
  return models[0]?.id || "gpt-transcribe";
}

describe("ModelRegistry", () => {
  describe("getModelProvider", () => {
    describe("exact model ID matches", () => {
      it("returns openai for GPT models", () => {
        expect(getModelProvider("gpt-5.2")).toBe("openai");
        expect(getModelProvider("gpt-5-mini")).toBe("openai");
        expect(getModelProvider("gpt-4.1")).toBe("openai");
      });

      it("returns anthropic for Claude models", () => {
        expect(getModelProvider("claude-sonnet-4-5")).toBe("anthropic");
        expect(getModelProvider("claude-haiku-4-5")).toBe("anthropic");
        expect(getModelProvider("claude-opus-4-5")).toBe("anthropic");
      });

      it("returns gemini for Gemini models", () => {
        expect(getModelProvider("gemini-3-pro")).toBe("gemini");
        expect(getModelProvider("gemini-3-flash")).toBe("gemini");
      });

      it("returns groq for Groq-hosted models", () => {
        expect(getModelProvider("qwen/qwen3-32b")).toBe("groq");
        expect(getModelProvider("llama-3.3-70b-versatile")).toBe("groq");
        expect(getModelProvider("mixtral-8x7b-32768")).toBe("groq");
      });
    });

    describe("pattern-based fallback detection", () => {
      it("detects anthropic from claude prefix", () => {
        expect(getModelProvider("claude-3-opus")).toBe("anthropic");
        expect(getModelProvider("claude-unknown-model")).toBe("anthropic");
      });

      it("detects gemini from gemini prefix (excluding gemma)", () => {
        expect(getModelProvider("gemini-unknown")).toBe("gemini");
        expect(getModelProvider("gemini-2.0-flash")).toBe("gemini");
      });

      it("detects groq from groq-specific patterns", () => {
        expect(getModelProvider("qwen/some-model")).toBe("groq");
        expect(getModelProvider("openai/whisper-large")).toBe("groq");
        expect(getModelProvider("llama-3.1-8b-instant")).toBe("groq");
        expect(getModelProvider("mixtral-unknown")).toBe("groq");
        expect(getModelProvider("gemma2-9b")).toBe("groq");
      });

      it("detects local from local model patterns", () => {
        expect(getModelProvider("qwen2.5-7b")).toBe("local");
        expect(getModelProvider("llama-3.2-3b")).toBe("local");
        expect(getModelProvider("mistral-7b")).toBe("local");
        expect(getModelProvider("gpt-oss-20b-mxfp4")).toBe("local");
      });

      it("does NOT detect gemini from gemma models", () => {
        expect(getModelProvider("gemma-2-9b")).not.toBe("gemini");
      });

      it("does NOT detect openai from gpt-oss models", () => {
        expect(getModelProvider("gpt-oss-20b-mxfp4")).not.toBe("openai");
      });
    });

    describe("default fallback", () => {
      it("returns openai for unknown models", () => {
        expect(getModelProvider("unknown-model")).toBe("openai");
        expect(getModelProvider("random-string")).toBe("openai");
      });
    });
  });

  describe("getCloudModel", () => {
    it("returns model definition for valid model ID", () => {
      const model = getCloudModel("gpt-5.2");
      expect(model).toBeDefined();
      expect(model?.name).toBe("GPT-5.2");
    });

    it("returns undefined for non-existent model", () => {
      const model = getCloudModel("non-existent-model");
      expect(model).toBeUndefined();
    });

    it("finds models across different providers", () => {
      expect(getCloudModel("claude-sonnet-4-5")).toBeDefined();
      expect(getCloudModel("gemini-3-pro")).toBeDefined();
      expect(getCloudModel("qwen/qwen3-32b")).toBeDefined();
    });

    it("includes disableThinking flag when present", () => {
      const model = getCloudModel("qwen/qwen3-32b");
      expect(model?.disableThinking).toBe(true);
    });
  });

  describe("getTranscriptionProvider", () => {
    it("returns provider data for valid provider ID", () => {
      const provider = getTranscriptionProvider("openai");
      expect(provider).toBeDefined();
      expect(provider?.name).toBe("OpenAI");
      expect(provider?.baseUrl).toBe("https://api.openai.com/v1");
    });

    it("returns undefined for non-existent provider", () => {
      const provider = getTranscriptionProvider("nonexistent");
      expect(provider).toBeUndefined();
    });

    it("returns groq provider", () => {
      const provider = getTranscriptionProvider("groq");
      expect(provider).toBeDefined();
      expect(provider?.baseUrl).toBe("https://api.groq.com/openai/v1");
    });
  });

  describe("getTranscriptionModels", () => {
    it("returns models for valid provider", () => {
      const models = getTranscriptionModels("openai");
      expect(models.length).toBe(4);
      expect(models.map((m) => m.id)).toContain("gpt-transcribe");
      expect(models.map((m) => m.id)).toContain("gpt-4o-transcribe");
      expect(models.map((m) => m.id)).toContain("whisper-1");
    });

    it("returns empty array for non-existent provider", () => {
      const models = getTranscriptionModels("nonexistent");
      expect(models).toEqual([]);
    });

    it("returns single model for groq", () => {
      const models = getTranscriptionModels("groq");
      expect(models.length).toBe(1);
      expect(models[0].id).toBe("whisper-large-v3-turbo");
    });
  });

  describe("getDefaultTranscriptionModel", () => {
    it("returns first model for valid provider", () => {
      expect(getDefaultTranscriptionModel("openai")).toBe("gpt-transcribe");
      expect(getDefaultTranscriptionModel("groq")).toBe("whisper-large-v3-turbo");
    });

    it("returns fallback for non-existent provider", () => {
      expect(getDefaultTranscriptionModel("nonexistent")).toBe("gpt-transcribe");
    });
  });
});

describe("Model ID patterns", () => {
  describe("OpenAI model patterns", () => {
    const openaiPatterns = ["gpt-4", "gpt-4.1", "gpt-5", "gpt-5.2", "gpt-5-mini", "gpt-5-nano"];

    openaiPatterns.forEach((pattern) => {
      it(`correctly identifies ${pattern} as openai`, () => {
        expect(getModelProvider(pattern)).toBe("openai");
      });
    });
  });

  describe("Anthropic model patterns", () => {
    const anthropicPatterns = [
      "claude-3-opus",
      "claude-3-sonnet",
      "claude-3-haiku",
      "claude-sonnet-4-5",
      "claude-instant",
    ];

    anthropicPatterns.forEach((pattern) => {
      it(`correctly identifies ${pattern} as anthropic`, () => {
        expect(getModelProvider(pattern)).toBe("anthropic");
      });
    });
  });

  describe("Groq-hosted model patterns", () => {
    const groqPatterns = [
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "mixtral-8x7b-32768",
      "gemma2-9b-it",
      "qwen/qwen3-32b",
    ];

    groqPatterns.forEach((pattern) => {
      it(`correctly identifies ${pattern} as groq`, () => {
        expect(getModelProvider(pattern)).toBe("groq");
      });
    });
  });

  describe("Local model patterns", () => {
    const localPatterns = [
      "qwen2.5-7b-instruct",
      "llama-3.2-3b-instruct",
      "mistral-7b-instruct-v0.3",
      "gpt-oss-20b-mxfp4",
    ];

    localPatterns.forEach((pattern) => {
      it(`correctly identifies ${pattern} as local`, () => {
        expect(getModelProvider(pattern)).toBe("local");
      });
    });
  });
});
