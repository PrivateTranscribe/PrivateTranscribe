import { test, expect } from "./fixtures/electron-app";

/**
 * Onboarding never asked which language the user dictates in, so every
 * non-English user silently started on auto-detect. Auto-detect guesses from
 * the opening seconds of audio and confuses languages that sound alike, which
 * is how a Danish recording comes back looking like Norwegian.
 *
 * It now asks for the languages the user speaks rather than one dictation
 * language, because a bilingual user answering the old question honestly
 * ended up right back on unconstrained auto-detect.
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
  test("asks which languages the user speaks during setup", async ({ controlPanel }) => {
    await openSetupStep(controlPanel);

    const section = controlPanel.getByTestId("onboarding-language");
    await expect(section).toContainText("Which languages do you speak?");

    // Nothing named yet means unconstrained auto-detect, so the user has to be
    // told what that costs. The wording comes from the shared status line,
    // which states what the next dictation will actually do.
    const hint = controlPanel.getByTestId("onboarding-language-hint");
    await expect(hint).toContainText("Auto-detect is on");
    await expect(hint).toContainText("Danish and Norwegian");

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
      .poll(async () => controlPanel.evaluate(() => localStorage.getItem("spokenLanguages")))
      .toBe(JSON.stringify(["da"]));

    // A single language is pinned outright rather than left to detection,
    // which is the whole accuracy win of asking the question.
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

  // Both specs below pin the selection to Base. The picker drops a model that
  // is not on disk and snaps to the first downloaded one, so without a seeded
  // cache these assert against whatever the machine happens to have — they
  // passed only on a developer box that had Base downloaded.
  test.describe("with Base downloaded", () => {
    test.use({ seedWhisperModels: ["base"] });

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

    test("lowers the accuracy meters once a non-English language is set", async ({
      controlPanel,
    }) => {
      // The meters were language-blind, so Base advertised a middling accuracy
      // bar to a Danish user while getting most of their words wrong.
      const filledBars = async () =>
        controlPanel
          .locator('[title^="Accuracy"]')
          .first()
          .evaluate((el) => el.getAttribute("title"));

      await controlPanel.evaluate(() => {
        localStorage.setItem("preferredLanguage", "en");
        localStorage.setItem("useLocalWhisper", "true");
        localStorage.setItem("whisperModel", "base");
      });
      await openSetupStep(controlPanel);
      const englishTitle = await filledBars();

      await controlPanel.evaluate(() => localStorage.setItem("preferredLanguage", "da"));
      await openSetupStep(controlPanel);
      const danishTitle = await filledBars();

      expect(englishTitle).not.toBe(danishTitle);

      const englishValue = Number(englishTitle?.match(/(\d)\/5/)?.[1]);
      const danishValue = Number(danishTitle?.match(/(\d)\/5/)?.[1]);
      expect(danishValue).toBeLessThan(englishValue);

      await controlPanel.screenshot({
        path: "test-results/e2e/onboarding-accuracy-meters-danish.png",
        fullPage: true,
      });
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

    // An install that predates the spoken set still counts as having answered:
    // its existing language stands in as a set of one.
    await controlPanel.evaluate(() => localStorage.setItem("preferredLanguage", "en"));
    await controlPanel.reload({ waitUntil: "domcontentloaded" });
    await expect(controlPanel.getByTestId("onboarding-language")).toBeVisible();

    // The hint still states what will happen, because that is useful for every
    // language. What English does not get is the lower-accuracy caveat.
    const hint = controlPanel.getByTestId("onboarding-language-hint");
    await expect(hint).toContainText("Set to English");
    await expect(hint).not.toContainText("Accuracy outside English is lower");
  });
});
