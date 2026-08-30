import { expect, test } from "./fixtures/electron-app";

/**
 * Settings are spread across nine tabs and several pages of their own, and
 * nothing pointed at a specific one. Finding a setting meant remembering which
 * tab it was under, which is exactly what a person who cannot find it does not
 * have.
 *
 * These specs drive the real window: whether a search result actually lands you
 * on the row is a thing you have to look at, not a thing you can unit test.
 */
test.describe("settings search", () => {
  const openSettings = async (controlPanel: any) => {
    await controlPanel.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(controlPanel.getByRole("searchbox", { name: "Search settings" })).toBeVisible();
  };

  test("sits above the tabs, empty and unobtrusive", async ({ controlPanel }) => {
    await openSettings(controlPanel);

    const search = controlPanel.getByRole("searchbox", { name: "Search settings" });
    await expect(search).toHaveValue("");
    // Nothing is suggested until something is typed - an unprompted dropdown
    // over a settings page is noise.
    await expect(
      controlPanel.getByRole("listbox", { name: "Settings search results" })
    ).toHaveCount(0);

    await controlPanel.screenshot({
      path: "test-results/e2e/settings-search-empty.png",
      fullPage: true,
    });
  });

  test("finds a setting by a word that appears nowhere on its row", async ({ controlPanel }) => {
    await openSettings(controlPanel);
    await controlPanel
      .getByRole("searchbox", { name: "Search settings" })
      .fill("correction memory");

    const results = controlPanel.getByRole("listbox", { name: "Settings search results" });
    await expect(results).toBeVisible();
    await expect(
      results.getByRole("option", { name: /Learn phrase and sentence rewrites/ })
    ).toBeVisible();

    await controlPanel.screenshot({
      path: "test-results/e2e/settings-search-results.png",
      fullPage: true,
    });
  });

  test("jumps to the right tab and marks the row", async ({ controlPanel }) => {
    await openSettings(controlPanel);
    await controlPanel.getByRole("searchbox", { name: "Search settings" }).fill("telemetry");
    await controlPanel.getByRole("option", { name: /Optional product analytics/ }).click();

    // The row lives under Preferences; the search opened that tab on its own.
    const row = controlPanel.locator('[data-settings-label="Optional product analytics"]');
    await expect(row).toBeVisible();
    await expect(row).toHaveClass(/settings-row-found/);

    // The scroll is what makes the mark worth having, so wait for it to settle
    // and capture the viewport. A full-page shot renders the whole document and
    // would frame the top of the page rather than the row that was found.
    await controlPanel.waitForFunction(
      () => {
        const found = document.querySelector('[data-settings-label="Optional product analytics"]');
        if (!found) return false;
        const top = Math.round(found.getBoundingClientRect().top);
        // Smooth scrolling means "inside the viewport" is true long before the
        // scroll stops. Wait for two identical frames, so the shot is the
        // resting position rather than a frame on the way there.
        const previous = (window as any).__settingsSearchProbe;
        (window as any).__settingsSearchProbe = top;
        return previous === top && top > 0 && top < window.innerHeight;
      },
      undefined,
      { timeout: 5000 }
    );

    await controlPanel.screenshot({ path: "test-results/e2e/settings-search-jumped.png" });
  });

  test("says so plainly when nothing matches", async ({ controlPanel }) => {
    await openSettings(controlPanel);
    await controlPanel.getByRole("searchbox", { name: "Search settings" }).fill("qwertyuiop");

    await expect(controlPanel.getByText(/No setting matches/)).toBeVisible();
    await expect(
      controlPanel.getByRole("listbox", { name: "Settings search results" })
    ).toHaveCount(0);

    await controlPanel.screenshot({
      path: "test-results/e2e/settings-search-no-match.png",
      fullPage: true,
    });
  });

  test("leaves Settings for a result that lives on another page", async ({ controlPanel }) => {
    await openSettings(controlPanel);
    await controlPanel.getByRole("searchbox", { name: "Search settings" }).fill("voice model");
    await controlPanel.getByRole("option", { name: /Voice model/ }).click();

    // Half of what a user calls "settings" is not on the Settings page, so a
    // search that could not cross pages would still leave them hunting.
    await expect(controlPanel.getByRole("heading", { name: "Read Aloud" }).first()).toBeVisible();

    await controlPanel.screenshot({
      path: "test-results/e2e/settings-search-cross-page.png",
      fullPage: true,
    });
  });

  test("is reachable with the key people already press to find things", async ({
    controlPanel,
  }) => {
    await openSettings(controlPanel);
    await controlPanel.getByRole("heading", { name: "Settings" }).first().click();

    await controlPanel.keyboard.press("Control+f");
    await expect(controlPanel.getByRole("searchbox", { name: "Search settings" })).toBeFocused();
  });
});
