import { expect, test } from "./fixtures/electron-app";

/**
 * Settings renders the same model picker as onboarding, and it was changed to
 * take the dictation language so the accuracy meters can reflect it. Nothing
 * covered that page, so a break there would only have shown up in front of a
 * user.
 */
test.describe("settings transcription language", () => {
  test("opens Settings without renderer errors", async ({ controlPanel, consoleMessages }) => {
    await controlPanel.evaluate(() => {
      localStorage.setItem("useLocalWhisper", "true");
      localStorage.setItem("whisperModel", "base");
      localStorage.setItem("preferredLanguage", "da");
    });
    await controlPanel.reload({ waitUntil: "domcontentloaded" });
    await controlPanel.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(controlPanel.getByRole("heading", { name: "Settings" })).toBeVisible();

    await controlPanel.screenshot({
      path: "test-results/e2e/settings-page.png",
      fullPage: true,
    });

    // Matching the convention in app-launch.spec.ts: console warnings are
    // expected noise (the dev CSP entries fire on every load), an uncaught
    // renderer exception is not.
    const pageErrors = consoleMessages.filter((m) => m.type === "pageerror");
    expect(pageErrors, `Renderer threw: ${pageErrors.map((e) => e.text).join(" | ")}`).toEqual([]);
  });

  test("shows lower accuracy meters in Settings for a non-English language", async ({
    controlPanel,
  }) => {
    // The same language-aware rating the onboarding step uses. Settings reads
    // its own copy of the setting, so it can regress independently.
    // Every meter, not just the first. The first card is turbo, which rates 4
    // in both languages by design, so asserting on it alone would look like a
    // failure while the feature worked.
    const meterValues = async () =>
      controlPanel
        .locator('[title^="Accuracy"]')
        .evaluateAll((els) =>
          els.map((el) => Number(el.getAttribute("title")?.match(/(\d)\/5/)?.[1]))
        );

    // The picker lives on the Dictation page.
    const openTranscriptionTab = async (language: string) => {
      await controlPanel.evaluate((lang) => {
        localStorage.setItem("useLocalWhisper", "true");
        localStorage.setItem("whisperModel", "base");
        localStorage.setItem("preferredLanguage", lang);
      }, language);
      await controlPanel.reload({ waitUntil: "domcontentloaded" });
      await controlPanel.getByRole("button", { name: "Dictation", exact: true }).click();
      await expect(controlPanel.locator('[title^="Accuracy"]').first()).toBeVisible();
    };

    await openTranscriptionTab("en");
    const english = await meterValues();

    await openTranscriptionTab("da");
    const danish = await meterValues();

    expect(danish.length).toBe(english.length);
    expect(danish.length).toBeGreaterThan(0);

    // No model may look better outside English...
    for (const [i, value] of danish.entries()) {
      expect(value, `model index ${i} rated higher for Danish`).toBeLessThanOrEqual(english[i]);
    }
    // ...and the smaller models must visibly drop, which is the whole point.
    expect(
      danish.some((value, i) => value < english[i]),
      `no meter dropped for Danish: en=${english.join(",")} da=${danish.join(",")}`
    ).toBe(true);

    await controlPanel.screenshot({
      path: "test-results/e2e/settings-transcription-danish.png",
      fullPage: true,
    });
  });
});
