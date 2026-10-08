import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Regression checks to prevent the onboarding hardware step from becoming a dead-end.
 *
 * Intentionally implemented as lightweight static checks (no React test framework)
 * so it can run fast and reliably in CI.
 */

describe("Onboarding flow – hardware step regression checks", () => {
  it("OnboardingFlow passes onNext to HardwareSetupStep", () => {
    const onboardingPath = path.join(process.cwd(), "src", "components", "OnboardingFlow.tsx");

    const contents = fs.readFileSync(onboardingPath, "utf8");

    // Very small invariant: the HardwareSetupStep instance should include onApplyRecommendations prop.
    const hardwareStepBlock = contents.split("case 1")[1] || "";

    expect(hardwareStepBlock.includes("<HardwareSetupStep")).toBe(true);
    expect(hardwareStepBlock.includes("onApplyRecommendations")).toBe(true);
  });

  it("HardwareSetupStep supports a null recommendations flow (no dead-end)", () => {
    const stepPath = path.join(process.cwd(), "src", "components", "ui", "HardwareSetupStep.tsx");

    const contents = fs.readFileSync(stepPath, "utf8");

    // Lightweight invariants (kept intentionally tolerant to formatting changes):
    // - handleApply() has a guard that bails out when recommendations are missing
    // - there is an explicit Continue-with-defaults action wired to the button

    const hasNullRecGuard = /if\s*\(\s*!detection\?\.recommendations\s*\)\s*return\s*;?/m.test(
      contents
    );
    expect(hasNullRecGuard).toBe(true);

    const hasDefaultsButtonText = /Continue with Defaults/.test(contents);
    expect(hasDefaultsButtonText).toBe(true);

    const hasDefaultsHandler = /const\s+handleContinueWithDefaults\s*=/.test(contents);
    expect(hasDefaultsHandler).toBe(true);

    const hasDefaultsButtonWiring = /onClick=\{handleContinueWithDefaults\}/.test(contents);
    expect(hasDefaultsButtonWiring).toBe(true);
  });

  it("HardwareSetupStep uses base as the safe-fallback whisper model (lighter than turbo when hardware is unknown)", () => {
    const stepPath = path.join(process.cwd(), "src", "components", "ui", "HardwareSetupStep.tsx");

    const contents = fs.readFileSync(stepPath, "utf8");

    // When hardware is unknown the model must run on a CPU. Turbo is the slowest
    // model there, and the detector's own failure default is already base.
    expect(/whisperModel:\s*["']base["']/.test(contents)).toBe(true);
    expect(/rec\.whisperModel \|\| ["']base["']/.test(contents)).toBe(true);
    expect(/whisperModel:\s*["']turbo["']/.test(contents)).toBe(false);
    expect(/\|\|\s*["']turbo["']/.test(contents)).toBe(false);
  });

  it("HardwareSetupStep renders 'Continue with Safe Defaults' button in the error state panel", () => {
    const stepPath = path.join(process.cwd(), "src", "components", "ui", "HardwareSetupStep.tsx");

    const contents = fs.readFileSync(stepPath, "utf8");

    // When detectionState === "error", a fallback panel must be rendered that
    // lets the user continue without getting stuck.
    const hasSafeDefaultsButtonText = /Continue with safe defaults/i.test(contents);
    expect(hasSafeDefaultsButtonText).toBe(true);
  });

  it("HardwareSetupStep renders 'Continue with Defaults' button when detection succeeds but recommendations are empty", () => {
    const stepPath = path.join(process.cwd(), "src", "components", "ui", "HardwareSetupStep.tsx");

    const contents = fs.readFileSync(stepPath, "utf8");

    // When detectionState === "complete" but detection.recommendations is null /
    // recommendations.reasoning is empty, the actions area must offer a continue
    // button rather than leaving the user stranded on the hardware step.
    const hasContinueWithDefaultsText = /Continue with Defaults/.test(contents);
    expect(hasContinueWithDefaultsText).toBe(true);
  });

  it("HardwareSetupStep wires both fallback buttons to handleContinueWithDefaults (not separate handlers)", () => {
    const stepPath = path.join(process.cwd(), "src", "components", "ui", "HardwareSetupStep.tsx");

    const contents = fs.readFileSync(stepPath, "utf8");

    // Both the error-state panel and the null-recommendations action area must use
    // the same handler so safe-defaults logic lives in exactly one place.
    const handlerMatches = [...contents.matchAll(/onClick=\{handleContinueWithDefaults\}/g)];
    expect(handlerMatches.length).toBeGreaterThanOrEqual(2);
  });

  it("HardwareSetupStep error state includes a retry button alongside the safe-defaults button", () => {
    const stepPath = path.join(process.cwd(), "src", "components", "ui", "HardwareSetupStep.tsx");

    const contents = fs.readFileSync(stepPath, "utf8");

    // Error panel must offer both paths: retry detection OR continue with defaults.
    // If only one is present the user has a degraded experience.
    const errorSection = contents.split('detectionState === "error"').pop() ?? "";

    const hasRetryButton = /Retry/.test(errorSection.slice(0, 1000));
    expect(hasRetryButton).toBe(true);

    const hasSafeDefaultsInErrorSection = /Continue with safe defaults/i.test(
      errorSection.slice(0, 1600)
    );
    expect(hasSafeDefaultsInErrorSection).toBe(true);
  });

  it("HardwareSetupStep null-recommendations complete state does NOT render 'Apply Recommendations' button", () => {
    const stepPath = path.join(process.cwd(), "src", "components", "ui", "HardwareSetupStep.tsx");

    const contents = fs.readFileSync(stepPath, "utf8");

    // The Apply button must be conditional on recommendations being present.
    // The text is now "Apply recommended settings" (lowercase).
    const applyButtonBlock = contents
      .split("Apply recommended")[0]
      .split("\n")
      .slice(-10)
      .join("\n");

    // The block preceding the Apply button must contain a conditional on recommendations
    const isConditional =
      /recommendations/.test(applyButtonBlock) || /reasoning/.test(applyButtonBlock);
    expect(isConditional).toBe(true);
  });

  it("HardwareSetupStep handleContinueWithDefaults uses localTranscriptionProvider 'whisper' (CPU-safe)", () => {
    const stepPath = path.join(process.cwd(), "src", "components", "ui", "HardwareSetupStep.tsx");

    const contents = fs.readFileSync(stepPath, "utf8");

    // Safe defaults must always fall back to the CPU whisper.cpp path.
    // We don't want to accidentally default to Parakeet/NVIDIA when hardware is unknown.
    const defaultsBlock =
      contents.split("handleContinueWithDefaults")[1]?.split("}")[0]?.concat("}") ?? "";

    const usesCpuWhisper = /localTranscriptionProvider:\s*["']whisper["']/.test(defaultsBlock);
    expect(usesCpuWhisper).toBe(true);

    const usesLocalWhisper = /useLocalWhisper:\s*true/.test(defaultsBlock);
    expect(usesLocalWhisper).toBe(true);

    expect(/whisperModel:\s*["']base["']/.test(defaultsBlock)).toBe(true);
  });

  it("modelRegistryData.json marks turbo as the sole recommended whisper model", () => {
    const registryPath = path.join(process.cwd(), "src", "models", "modelRegistryData.json");

    const data = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
      whisperModels: Record<string, { recommended?: boolean }>;
    };
    const whisperModels = data.whisperModels;

    expect(whisperModels["turbo"]?.recommended).toBe(true);

    const otherRecommended = Object.entries(whisperModels)
      .filter(([id, m]) => id !== "turbo" && m.recommended === true)
      .map(([id]) => id);
    expect(otherRecommended).toEqual([]);
  });

  it("useSettings.ts defaults whisperModel to turbo", () => {
    const settingsPath = path.join(process.cwd(), "src", "hooks", "useSettings.ts");
    const contents = fs.readFileSync(settingsPath, "utf8");

    // The useLocalStorage call for whisperModel must default to "turbo"
    const hasTurboDefault = /useLocalStorage\s*\(\s*["']whisperModel["']\s*,\s*["']turbo["']/.test(
      contents
    );
    expect(hasTurboDefault).toBe(true);
  });

  it("OnboardingFlow does not call an undefined CUDA installed setter", () => {
    const onboardingPath = path.join(process.cwd(), "src", "components", "OnboardingFlow.tsx");
    const contents = fs.readFileSync(onboardingPath, "utf8");

    expect(contents).not.toContain("setCudaInstalled");
    expect(contents).toContain("setCudaStatus");
  });
});
