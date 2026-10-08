import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { getWhisperPerfRating } from "../../../src/utils/modelAccuracy";

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

    it("Qwen provider recommends the compact cleanup model", () => {
      const data = readRegistry();
      const qwen = data.localProviders.find((p) => p.id === "qwen");
      expect(qwen).toBeDefined();
      const recommended = qwen!.models.filter((m) => m.recommended === true);
      expect(recommended).toHaveLength(1);
      expect(recommended[0].id).toBe("qwen3.8-2b-distill-q4_k_m");
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
      // The ratings moved out of the component into src/utils/modelAccuracy.ts
      // when they became language-aware, so assert the values themselves
      // rather than matching the source text they used to be written in.
      expect(getWhisperPerfRating("tiny", "en")).toEqual({ speed: 5, quality: 1 });
      expect(getWhisperPerfRating("large", "en")).toEqual({ speed: 1, quality: 5 });
      expect(getWhisperPerfRating("turbo", "en")).toEqual({ speed: 4, quality: 4 });
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
    it("no longer downloads the retired sherpa-onnx WebSocket server", () => {
      // It listened on every network interface with no password; Parakeet now runs
      // in a utility process through the sherpa-onnx-node package instead.
      expect(fs.existsSync(path.join(process.cwd(), "scripts", "download-sherpa-onnx.js"))).toBe(
        false
      );
      const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
      expect(JSON.stringify(pkg.scripts)).not.toContain("sherpa-onnx");
    });

    it("download-whisper-cpp.js respects WHISPER_CPP_VERSION env override", () => {
      const scriptPath = path.join(process.cwd(), "scripts", "download-whisper-cpp.js");
      const contents = fs.readFileSync(scriptPath, "utf8");

      expect(contents).toMatch(/process\.env\.WHISPER_CPP_VERSION/);
    });
  });
});
