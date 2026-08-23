import { expect, test } from "./fixtures/electron-app";

/**
 * The spoken-language picker first shipped as a floating dropdown, which
 * SettingsPanel's overflow-hidden clipped to a single visible entry. The other
 * 57 languages could not be reached at all, and the row showed nothing about
 * auto-detect being the active state while the copy beside it talked about
 * auto-detect. Both were found by looking at the real screen, not by a test.
 */
async function openLanguageSettings(page: import("@playwright/test").Page, spoken: string[]) {
  await page.evaluate((languages) => {
    localStorage.setItem("spokenLanguages", JSON.stringify(languages));
  }, spoken);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Preferences", exact: true }).click();
}

test.describe("spoken language picker", () => {
  test("reaches every language instead of clipping after the first", async ({ controlPanel }) => {
    await openLanguageSettings(controlPanel, []);
    await controlPanel.getByRole("button", { name: /Add a language/ }).click();

    // Every language the picker offers, minus "auto" which is a mode.
    await expect(controlPanel.getByRole("option")).toHaveCount(57);

    // The last one is only reachable if the list scrolls rather than being cut
    // off by an ancestor's overflow.
    const welsh = controlPanel.getByRole("option", { name: "Welsh" });
    await welsh.scrollIntoViewIfNeeded();
    await expect(welsh).toBeVisible();

    await controlPanel.screenshot({
      path: "test-results/e2e/language-picker-open.png",
      fullPage: true,
    });
  });

  test("shows auto-detect as a state rather than an empty row", async ({ controlPanel }) => {
    await openLanguageSettings(controlPanel, []);

    await expect(controlPanel.getByText("Auto-detect", { exact: true })).toBeVisible();
    await expect(controlPanel.getByText(/Auto-detect is on\./)).toBeVisible();
  });

  test("says what will happen once languages are named", async ({ controlPanel }) => {
    await openLanguageSettings(controlPanel, ["da", "en"]);

    await expect(
      controlPanel.getByText(
        "Detecting between Danish and English. No other language can be picked."
      )
    ).toBeVisible();
    await expect(controlPanel.getByText("Auto-detect", { exact: true })).toHaveCount(0);
  });

  test("stops pinning the first language when a second one is added", async ({ controlPanel }) => {
    // The bug: picking Danish pins preferredLanguage to "da". Adding English
    // preserved that pin, so English speech came back transcribed as Danish
    // while the row claimed it was detecting between the two.
    await openLanguageSettings(controlPanel, ["da"]);
    await controlPanel.evaluate(() => localStorage.setItem("preferredLanguage", "da"));

    await controlPanel.getByRole("button", { name: /Add another/ }).click();
    await controlPanel.getByRole("option", { name: "English" }).click();

    await expect
      .poll(async () => controlPanel.evaluate(() => localStorage.getItem("preferredLanguage")))
      .toBe("auto");
  });

  test("admits when it is pinned, and offers the way out", async ({ controlPanel }) => {
    // Reachable legitimately: the overlay's quick-switch menu pins a language.
    // Settings has to describe that honestly and be able to clear it.
    await openLanguageSettings(controlPanel, ["da", "en"]);
    await controlPanel.evaluate(() => localStorage.setItem("preferredLanguage", "da"));
    await controlPanel.reload({ waitUntil: "domcontentloaded" });
    await controlPanel.getByRole("button", { name: "Settings", exact: true }).click();
    await controlPanel.getByRole("button", { name: "Preferences", exact: true }).click();

    await expect(controlPanel.getByText(/Pinned to Danish/)).toBeVisible();

    await controlPanel.getByRole("button", { name: "Switch to automatic" }).click();
    await expect
      .poll(async () => controlPanel.evaluate(() => localStorage.getItem("preferredLanguage")))
      .toBe("auto");
    await expect(controlPanel.getByText(/Detecting between Danish and English/)).toBeVisible();
  });

  test("removing the last language goes back to auto-detect", async ({ controlPanel }) => {
    // The chip used to reappear the moment it was removed: clearing the list
    // left the old pin behind, and the pin was read back as a set of one.
    await openLanguageSettings(controlPanel, ["da"]);

    await controlPanel.getByRole("button", { name: "Remove Danish" }).click();

    await expect(controlPanel.getByText("Auto-detect", { exact: true })).toBeVisible();
    await expect(controlPanel.getByText("Danish", { exact: true })).toHaveCount(0);
    await expect
      .poll(async () => controlPanel.evaluate(() => localStorage.getItem("preferredLanguage")))
      .toBe("auto");

    // And it stays gone across a reload rather than being resurrected.
    await controlPanel.reload({ waitUntil: "domcontentloaded" });
    await controlPanel.getByRole("button", { name: "Settings", exact: true }).click();
    await controlPanel.getByRole("button", { name: "Preferences", exact: true }).click();
    await expect(controlPanel.getByText("Auto-detect", { exact: true })).toBeVisible();

    await controlPanel.screenshot({
      path: "test-results/e2e/language-picker-cleared.png",
      fullPage: true,
    });
  });

  test("can still be opened at the cap, so the limit is explained", async ({ controlPanel }) => {
    await openLanguageSettings(controlPanel, ["da", "en", "de", "fr", "es"]);

    // A disabled button here would hide its own explanation.
    await controlPanel.getByRole("button", { name: /Add another/ }).click();
    await expect(controlPanel.getByText(/Up to 5 languages/)).toBeVisible();
  });
});
