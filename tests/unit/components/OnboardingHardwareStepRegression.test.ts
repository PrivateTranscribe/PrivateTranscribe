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

    // Very small invariant: the HardwareSetupStep instance should include an onNext prop.
    const hardwareStepBlock = contents.split("case 1")[1] || "";

    expect(hardwareStepBlock.includes("<HardwareSetupStep")).toBe(true);
    expect(hardwareStepBlock.includes("onNext=")).toBe(true);
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

  it("HardwareSetupStep uses turbo as the default whisper model fallback", () => {
    const stepPath = path.join(process.cwd(), "src", "components", "ui", "HardwareSetupStep.tsx");

    const contents = fs.readFileSync(stepPath, "utf8");

    // The handleContinueWithDefaults function must set whisperModel to "turbo"
    // (not "base") so new users get the best-quality default out of the box.
    const hasTurboDefault = /whisperModel:\s*["']turbo["']/.test(contents);
    expect(hasTurboDefault).toBe(true);
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
});
