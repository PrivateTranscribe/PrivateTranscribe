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
    const onboardingPath = path.join(
      process.cwd(),
      "src",
      "components",
      "OnboardingFlow.tsx"
    );

    const contents = fs.readFileSync(onboardingPath, "utf8");

    // Very small invariant: the HardwareSetupStep instance should include an onNext prop.
    const hardwareStepBlock = contents.split("case 1")[1] || "";

    expect(hardwareStepBlock.includes("<HardwareSetupStep")).toBe(true);
    expect(hardwareStepBlock.includes("onNext=")).toBe(true);
  });

  it("HardwareSetupStep supports a null recommendations flow (no dead-end)", () => {
    const stepPath = path.join(
      process.cwd(),
      "src",
      "components",
      "ui",
      "HardwareSetupStep.tsx"
    );

    const contents = fs.readFileSync(stepPath, "utf8");

    // Lightweight invariants (kept intentionally tolerant to formatting changes):
    // - handleApply() has a guard that bails out when recommendations are missing
    // - there is an explicit Continue-with-defaults action wired to the button

    const hasNullRecGuard = /if\s*\(\s*!detection\?\.recommendations\s*\)\s*return\s*;?/m.test(contents);
    expect(hasNullRecGuard).toBe(true);

    const hasDefaultsButtonText = /Continue with Defaults/.test(contents);
    expect(hasDefaultsButtonText).toBe(true);

    const hasDefaultsHandler = /const\s+handleContinueWithDefaults\s*=/.test(contents);
    expect(hasDefaultsHandler).toBe(true);

    const hasDefaultsButtonWiring = /onClick=\{handleContinueWithDefaults\}/.test(contents);
    expect(hasDefaultsButtonWiring).toBe(true);
  });
});
