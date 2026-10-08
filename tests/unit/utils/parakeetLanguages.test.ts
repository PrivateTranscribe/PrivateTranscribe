import { describe, expect, it } from "vitest";
import {
  PARAKEET_LANGUAGES,
  baseLanguage,
  describeUnsupportedLanguages,
  evaluateParakeetFit,
  formatSpeedTestResult,
  languagesToCheck,
  recommendsParakeet,
  speedTestKeepsParakeet,
  unsupportedParakeetLanguages,
} from "../../../src/utils/parakeetLanguages";
import type { HardwareRecommendations } from "../../../src/types/electron";

function recs(overrides: Partial<HardwareRecommendations> = {}): HardwareRecommendations {
  return {
    transcriptionProvider: "local",
    localTranscriptionProvider: "whisper",
    whisperModel: "base",
    gpuCategory: "non_nvidia_gpu",
    reasoning: [],
    recoverySteps: [],
    parakeetHardware: { eligible: true, reasons: [] },
    ...overrides,
  } as HardwareRecommendations;
}

describe("Parakeet language check", () => {
  it("reads the 25 languages from the model registry", () => {
    expect(PARAKEET_LANGUAGES).toHaveLength(25);
    expect(PARAKEET_LANGUAGES).toContain("da");
    expect(PARAKEET_LANGUAGES).toContain("en");
  });

  it("checks the spoken languages when the user named some", () => {
    expect(languagesToCheck(["da", "en"], "ja-JP")).toEqual({
      codes: ["da", "en"],
      fromLocale: false,
    });
  });

  it("falls back to the UI locale's language when the spoken set is empty", () => {
    expect(languagesToCheck([], "da-DK")).toEqual({ codes: ["da"], fromLocale: true });
    expect(languagesToCheck([], "")).toEqual({ codes: [], fromLocale: true });
  });

  it("strips regions from locale codes", () => {
    expect(baseLanguage("pt_BR")).toBe("pt");
    expect(baseLanguage("EN-us")).toBe("en");
    expect(baseLanguage(undefined)).toBe("");
  });

  it("names the languages Parakeet does not cover", () => {
    expect(unsupportedParakeetLanguages(["da", "ja", "en", "ko"])).toEqual(["ja", "ko"]);
  });
});

describe("recommendsParakeet", () => {
  const smallCuda = () =>
    evaluateParakeetFit(recs({ gpuCategory: "nvidia_cuda", whisperModel: "small" }), ["en"], "en");

  it("follows the fit on a PC without NVIDIA, whatever Whisper model is in use", () => {
    expect(recommendsParakeet(evaluateParakeetFit(recs(), ["en"], "en"), "turbo")).toBe(true);
  });

  it("recommends Parakeet over a small model on a small NVIDIA card", () => {
    expect(recommendsParakeet(smallCuda(), "small")).toBe(true);
    expect(recommendsParakeet(smallCuda(), "base")).toBe(true);
  });

  it.each(["turbo", "large", "medium"])("leaves a hand-picked %s alone on NVIDIA", (model) => {
    expect(recommendsParakeet(smallCuda(), model)).toBe(false);
  });

  it("never recommends a PC that does not qualify", () => {
    expect(recommendsParakeet(null, "base")).toBe(false);
    expect(recommendsParakeet(evaluateParakeetFit(recs(), ["ja"], "en"), "base")).toBe(false);
  });
});

describe("evaluateParakeetFit", () => {
  it("qualifies a non-CUDA PC that passes hardware and languages", () => {
    const fit = evaluateParakeetFit(recs(), ["da", "en"], "en-US");
    expect(fit.qualifies).toBe(true);
    expect(fit.hardwareEligible).toBe(true);
  });

  it.each(["turbo", "large"])("keeps GPU Whisper on a CUDA card with room for %s", (model) => {
    const fit = evaluateParakeetFit(
      recs({ gpuCategory: "nvidia_cuda", whisperModel: model }),
      ["en"],
      "en-US"
    );
    expect(fit.isCudaPc).toBe(true);
    expect(fit.strongGpuWhisper).toBe(true);
    expect(fit.hardwareEligible).toBe(true);
    expect(fit.qualifies).toBe(false);
  });

  it.each(["base", "small"])("qualifies a CUDA card that only fits Whisper %s", (model) => {
    const fit = evaluateParakeetFit(
      recs({ gpuCategory: "nvidia_cuda", whisperModel: model }),
      ["da", "en"],
      "en-US"
    );
    expect(fit.isCudaPc).toBe(true);
    expect(fit.strongGpuWhisper).toBe(false);
    expect(fit.qualifies).toBe(true);
  });

  it("does not count a non-CUDA PC as strong GPU Whisper", () => {
    const fit = evaluateParakeetFit(recs({ whisperModel: "turbo" }), ["en"], "en-US");
    expect(fit.strongGpuWhisper).toBe(false);
    expect(fit.qualifies).toBe(true);
  });

  it("carries the hardware reasons when the PC is not eligible", () => {
    const reasons = ["This PC has 2 processor cores. Parakeet needs at least 4."];
    const fit = evaluateParakeetFit(
      recs({ parakeetHardware: { eligible: false, reasons } }),
      ["en"],
      "en-US"
    );
    expect(fit.qualifies).toBe(false);
    expect(fit.hardwareReasons).toEqual(reasons);
  });

  it("treats a missing hardware verdict as not eligible", () => {
    const fit = evaluateParakeetFit(recs({ parakeetHardware: undefined }), ["en"], "en-US");
    expect(fit.hardwareEligible).toBe(false);
    expect(evaluateParakeetFit(null, ["en"], "en-US").qualifies).toBe(false);
  });

  it("does not qualify when a spoken language is outside the 25", () => {
    const fit = evaluateParakeetFit(recs(), ["da", "ja"], "en-US");
    expect(fit.qualifies).toBe(false);
    expect(fit.unsupportedLanguages).toEqual(["ja"]);
    expect(describeUnsupportedLanguages(fit)).toBe(
      "Parakeet does not support Japanese. Whisper does."
    );
  });

  it("says when the language came from the PC's locale", () => {
    const fit = evaluateParakeetFit(recs(), [], "ja-JP");
    expect(fit.qualifies).toBe(false);
    expect(describeUnsupportedLanguages(fit)).toBe(
      "Parakeet does not support Japanese, the language this PC is set to. Whisper does."
    );
  });
});

describe("speed test decision", () => {
  it("keeps Parakeet only on a completed test that passed", () => {
    expect(speedTestKeepsParakeet({ success: true, decodeMs: 220, passed: true })).toBe(true);
    expect(speedTestKeepsParakeet({ success: true, decodeMs: 2400, passed: false })).toBe(false);
  });

  it("falls back when the test could not run", () => {
    expect(speedTestKeepsParakeet({ success: false })).toBe(false);
    expect(speedTestKeepsParakeet(null)).toBe(false);
    expect(speedTestKeepsParakeet(undefined)).toBe(false);
  });

  it("describes the result in plain words", () => {
    expect(formatSpeedTestResult({ success: true, decodeMs: 220, audioSec: 10.02 })).toBe(
      "10 s of speech in 0.2 s on this PC"
    );
    expect(formatSpeedTestResult({ success: true, decodeMs: 1340, audioSec: 10 })).toBe(
      "10 s of speech in 1.3 s on this PC"
    );
    expect(formatSpeedTestResult({ success: true, decodeMs: 30, audioSec: 10 })).toBe(
      "10 s of speech in 0.1 s on this PC"
    );
    expect(formatSpeedTestResult({ success: false })).toBeNull();
  });
});
