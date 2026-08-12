import { test, expect } from "./fixtures/electron-app";

/**
 * Onboarding never asked which language the user dictates in, so every
 * non-English user silently started on auto-detect. Auto-detect guesses from
 * the opening seconds of audio and confuses languages that sound alike, which
 * is how a Danish recording comes back looking like Norwegian.
 *
 * These specs drive the real first-run wizard in the packaged renderer.
 */
test.use({ completeOnboarding: false });

/** Land directly on the Setup step instead of clicking through Welcome and Hardware. */
async function openSetupStep(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    localStorage.removeItem("onboardingCompleted");
    localStorage.setItem("onboardingCurrentStep", "2");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("onboarding-language")).toBeVisible();
}

test.describe("Onboarding dictation language", () => {
  test("asks for the dictation language during setup", async ({ controlPanel }) => {
    await openSetupStep(controlPanel);

    const section = controlPanel.getByTestId("onboarding-language");
    await expect(section).toContainText("Dictation language");

    // Default is auto-detect, so the user has to be told what that costs.
    const hint = controlPanel.getByTestId("onboarding-language-hint");
    await expect(hint).toContainText("Auto-detect guesses");
    await expect(hint).toContainText("Danish, Norwegian and Swedish");

    // The question is worthless if the user never scrolls to it, so capture
    // what they actually land on rather than a scrolled-to-element shot.
    await section.scrollIntoViewIfNeeded();
    await controlPanel.screenshot({
      path: "test-results/e2e/onboarding-language-auto.png",
      fullPage: true,
    });
  });

  test("stores the choice and swaps the hint once a language is picked", async ({
    controlPanel,
  }) => {
    await openSetupStep(controlPanel);

    const section = controlPanel.getByTestId("onboarding-language");
    await section.getByRole("button").first().click();

    const search = controlPanel.getByPlaceholder(/search/i);
    await search.fill("Danish");
    await controlPanel.getByText("Danish", { exact: true }).first().click();

    // The picker is only useful if the setting actually survives the step.
    await expect
      .poll(async () => controlPanel.evaluate(() => localStorage.getItem("preferredLanguage")))
      .toBe("da");

    // Honest expectation-setting replaces the auto-detect warning.
    const hint = controlPanel.getByTestId("onboarding-language-hint");
    await expect(hint).toContainText("Accuracy outside English is lower");

    await controlPanel.screenshot({
      path: "test-results/e2e/onboarding-language-danish.png",
      fullPage: true,
    });
  });

  test("warns when a small model is paired with a non-English language", async ({
    controlPanel,
  }) => {
    // Measured: base scores 62.8% WER on Danish against turbo's 15.4%, while
    // both stay usable for English. Picking base for Danish is a cliff, and
    // the hardware step can recommend exactly that on a weak machine.
    await controlPanel.evaluate(() => {
      localStorage.setItem("preferredLanguage", "da");
      localStorage.setItem("useLocalWhisper", "true");
      localStorage.setItem("whisperModel", "base");
    });
    await openSetupStep(controlPanel);

    const warning = controlPanel.getByTestId("onboarding-language-model-warning");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("Danish");
    await expect(warning).toContainText("Turbo or Large");

    await warning.scrollIntoViewIfNeeded();
    await controlPanel.screenshot({
      path: "test-results/e2e/onboarding-language-warning.png",
      fullPage: true,
    });
  });

  test("stays quiet when the chosen model is strong enough", async ({ controlPanel }) => {
    await controlPanel.evaluate(() => {
      localStorage.setItem("preferredLanguage", "da");
      localStorage.setItem("useLocalWhisper", "true");
      localStorage.setItem("whisperModel", "turbo");
    });
    await openSetupStep(controlPanel);

    await expect(controlPanel.getByTestId("onboarding-language-model-warning")).toHaveCount(0);
  });

  test("shows no accuracy caveat for English, which needs none", async ({ controlPanel }) => {
    await openSetupStep(controlPanel);

    await controlPanel.evaluate(() => localStorage.setItem("preferredLanguage", "en"));
    await controlPanel.reload({ waitUntil: "domcontentloaded" });
    await expect(controlPanel.getByTestId("onboarding-language")).toBeVisible();

    await expect(controlPanel.getByTestId("onboarding-language-hint")).toHaveCount(0);
  });
});
