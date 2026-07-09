import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Regression checks for model curation invariants.
 *
 * These lightweight static checks (no React / Electron required) guard against
 * common drift patterns:
 *   - Multiple competing "recommended" models within a single local provider
 *   - Progressive disclosure accidentally hiding the wrong whisper models
 *   - Version-pin env var support being removed from the sherpa-onnx download script
 */

interface WhisperModelEntry {
  recommended?: boolean;
  [key: string]: unknown;
}

interface LocalModelEntry {
  id: string;
  recommended?: boolean;
  [key: string]: unknown;
}

interface LocalProviderEntry {
  id: string;
  name: string;
  models: LocalModelEntry[];
}

interface ModelRegistryData {
  whisperModels: Record<string, WhisperModelEntry>;
  localProviders: LocalProviderEntry[];
}

function readRegistry(): ModelRegistryData {
  const registryPath = path.join(process.cwd(), "src", "models", "modelRegistryData.json");
  return JSON.parse(fs.readFileSync(registryPath, "utf8")) as ModelRegistryData;
}

describe("Model curation invariants", () => {
  describe("Whisper model registry", () => {
    it("turbo is the sole recommended whisper model", () => {
      const data = readRegistry();
      const recommended = Object.entries(data.whisperModels)
        .filter(([, m]) => m.recommended === true)
        .map(([id]) => id);
      expect(recommended).toEqual(["turbo"]);
    });

    it("whisper models appear in curated order: turbo, base, small-en-tdrz, tiny, small, medium, large", () => {
      const data = readRegistry();
      const keys = Object.keys(data.whisperModels);
      const expectedOrder = ["turbo", "base", "small-en-tdrz", "tiny", "small", "medium", "large"];
      expect(keys).toEqual(expectedOrder);
    });

    it("small model description no longer says 'slower than Base' (confusing framing)", () => {
      const data = readRegistry();
      const smallDesc = data.whisperModels["small"]?.description ?? "";
      expect(smallDesc).not.toMatch(/slower than Base/i);
    });
  });

  describe("Local reasoning model curation", () => {
    it("each local provider has at most one recommended model", () => {
      const data = readRegistry();
      for (const provider of data.localProviders) {
        const recommended = provider.models.filter((m) => m.recommended === true);
        expect(recommended.length).toBeLessThanOrEqual(1);
      }
    });

    it("Qwen provider has exactly one recommended model (qwen3-8b-q4_k_m)", () => {
      const data = readRegistry();
      const qwen = data.localProviders.find((p) => p.id === "qwen");
      expect(qwen).toBeDefined();
      const recommended = qwen!.models.filter((m) => m.recommended === true);
      expect(recommended).toHaveLength(1);
      expect(recommended[0].id).toBe("qwen3-8b-q4_k_m");
    });

    it("Mistral provider has been removed (superseded by Qwen3)", () => {
      const data = readRegistry();
      const mistral = data.localProviders.find((p) => p.id === "mistral");
      expect(mistral).toBeUndefined();
    });

    it("Llama provider has been removed (superseded by Qwen3)", () => {
      const data = readRegistry();
      const llama = data.localProviders.find((p) => p.id === "llama");
      expect(llama).toBeUndefined();
    });
  });

  describe("Whisper onboarding cues", () => {
    it("TranscriptionModelPicker still detects the onboarding variant", () => {
      const pickerPath = path.join(
        process.cwd(),
        "src",
        "components",
        "TranscriptionModelPicker.tsx"
      );
      const contents = fs.readFileSync(pickerPath, "utf8");

      expect(contents).toMatch(/const isOnboarding = variant === "onboarding"/);
    });

    it("performance is shown as segmented speed/accuracy meters", () => {
      const pickerPath = path.join(
        process.cwd(),
        "src",
        "components",
        "TranscriptionModelPicker.tsx"
      );
      const contents = fs.readFileSync(pickerPath, "utf8");

      expect(contents).toContain("function PerfMeter");
      expect(contents).toMatch(/<PerfMeter label="Speed" value=\{perf\.speed\} \/>/);
      expect(contents).toMatch(/<PerfMeter label="Accuracy" value=\{perf\.quality\} \/>/);
    });

    it("Whisper speed/accuracy ratings invert (fast tiny, accurate large) and cover turbo", () => {
      const pickerPath = path.join(
        process.cwd(),
        "src",
        "components",
        "TranscriptionModelPicker.tsx"
      );
      const contents = fs.readFileSync(pickerPath, "utf8");

      expect(contents).toMatch(/tiny:\s*\{\s*speed:\s*5,\s*quality:\s*1\s*\}/);
      expect(contents).toMatch(/large:\s*\{\s*speed:\s*1,\s*quality:\s*5\s*\}/);
      expect(contents).toMatch(/turbo:\s*\{\s*speed:\s*4,\s*quality:\s*4\s*\}/);
    });

    it("model recommendation badges can use hardware recommendations instead of static registry defaults", () => {
      const pickerPath = path.join(
        process.cwd(),
        "src",
        "components",
        "TranscriptionModelPicker.tsx"
      );
      const contents = fs.readFileSync(pickerPath, "utf8");

      expect(contents).toContain("recommendedLocalModel?: string");
      expect(contents).toContain("modelId === recommendedLocalModel");
      expect(contents).toContain("recommended={isRecommended}");
    });

    it("onboarding collapsed model list includes the hardware recommended model", () => {
      const pickerPath = path.join(
        process.cwd(),
        "src",
        "components",
        "TranscriptionModelPicker.tsx"
      );
      const contents = fs.readFileSync(pickerPath, "utf8");

      expect(contents).toContain("getOnboardingCollapsedModelEntries");
      expect(contents).toContain('recommendedLocalModel ?? selectedLocalModel ?? "turbo"');
      expect(contents).not.toContain('allModelEntries.filter((model) => model.model === "turbo")');
    });
  });

  describe("Build script version pinning", () => {
    it("download-sherpa-onnx.js respects SHERPA_ONNX_VERSION env override", () => {
      const scriptPath = path.join(process.cwd(), "scripts", "download-sherpa-onnx.js");
      const contents = fs.readFileSync(scriptPath, "utf8");

      // Must read the env var, not use a bare constant
      expect(contents).toMatch(/process\.env\.SHERPA_ONNX_VERSION/);
    });

    it("download-sherpa-onnx.js has a hardcoded fallback version", () => {
      const scriptPath = path.join(process.cwd(), "scripts", "download-sherpa-onnx.js");
      const contents = fs.readFileSync(scriptPath, "utf8");

      // Fallback must be a real version string, not empty
      expect(contents).toMatch(
        /SHERPA_ONNX_VERSION\s*=\s*process\.env\.SHERPA_ONNX_VERSION\s*\|\|\s*"\d+\.\d+\.\d+"/
      );
    });

    it("download-whisper-cpp.js also uses env override (parity check)", () => {
      const scriptPath = path.join(process.cwd(), "scripts", "download-whisper-cpp.js");
      const contents = fs.readFileSync(scriptPath, "utf8");

      expect(contents).toMatch(/process\.env\.WHISPER_CPP_VERSION/);
    });
  });
});
