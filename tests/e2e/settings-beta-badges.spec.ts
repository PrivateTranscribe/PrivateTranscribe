import { expect, test } from "./fixtures/electron-app";

/**
 * The tester-only controls sat disabled with their reason buried in small
 * description text, so they read as broken rather than locked. The app also
 * used three words for one state: "Beta" in the sidebar, "Tester" on page
 * headers, "Approved testers only" on the Correction Memory page.
 *
 * These specs drive the real windows, because the thing being checked is
 * whether a locked control is legible on screen.
 */
test.describe("beta feature labelling", () => {
  test("badges the locked Smart Context toggle instead of only dimming it", async ({
    controlPanel,
  }) => {
    await controlPanel.getByRole("button", { name: "Settings", exact: true }).click();
    await controlPanel.getByRole("button", { name: "Preferences", exact: true }).click();

    // Walk up from the label to the SettingsRow that owns it, so the badge
    // and the control are asserted on the same row rather than on the page.
    const row = controlPanel
      .getByText("Smart Context", { exact: true })
      .locator("xpath=ancestor::div[contains(@class,'justify-between')][1]");

    // The row says Beta beside the control, not only inside its description.
    await expect(row.getByText("Beta", { exact: true })).toBeVisible();

    // Labelling is not enforcement: the control is genuinely unavailable too.
    // The toggle is a bare button, so it is located by position in the row.
    await expect(row.locator("button")).toBeDisabled();

    // The badge carries the word, so the description explains the state
    // rather than repeating the label.
    await expect(controlPanel.getByText("Beta - approved tester access")).toHaveCount(0);

    await controlPanel.screenshot({
      path: "test-results/e2e/settings-beta-smart-context.png",
      fullPage: true,
    });
  });

  test("uses one word for the locked state on a beta page", async ({ controlPanel }) => {
    await controlPanel.getByRole("button", { name: "AI Enhancement Beta" }).click();
    await expect(
      controlPanel.getByRole("heading", { name: "AI Enhancement" }).first()
    ).toBeVisible();

    // The header pill used to say "Tester" while the sidebar said "Beta".
    await expect(controlPanel.getByText("Tester", { exact: true })).toHaveCount(0);
    await expect(controlPanel.getByText("Approved testers only")).toHaveCount(0);

    await controlPanel.screenshot({
      path: "test-results/e2e/beta-page-header.png",
      fullPage: true,
    });
  });
});
