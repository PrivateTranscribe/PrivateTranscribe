import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";

/**
 * A locked beta control has to look locked, say so in one word, and offer the
 * way out: "Turn on beta features", which opens the Beta features tab in
 * Settings, where one switch unlocks every beta.
 *
 * These specs drive the real windows, because the thing being checked is
 * whether a locked control is legible on screen and whether its way out works.
 */

const WAY_OUT = "Turn on beta features";

/** The switch. The sidebar entry and the tab share its name, but only it has the label. */
const betaSwitch = (page: Page) => page.getByLabel("Beta features", { exact: true });

/**
 * Settings, open on the Beta features tab. The tab bar has no selected state to
 * read, so the tab's own heading and switch are the proof it is the open one.
 */
async function expectBetaFeaturesTab(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Beta features", exact: true })).toBeVisible();
  await expect(betaSwitch(page)).toBeVisible();
}

test.describe("beta feature labelling", () => {
  test("badges the locked Smart Context toggle and leads to the switch", async ({
    controlPanel,
  }) => {
    await controlPanel.getByRole("button", { name: "Settings", exact: true }).click();
    await controlPanel.locator("summary").filter({ hasText: "More settings" }).click();

    // The row a settings search scrolls to, so the badge and the control are
    // asserted on the same row rather than anywhere on the page.
    const row = controlPanel.locator('[data-settings-label="Smart Context"]');
    const toggle = row.locator("button[aria-pressed]");
    const wayOut = row.getByRole("button", { name: WAY_OUT, exact: true });

    // The row says Beta beside the control, not only inside its description.
    await expect(row.getByText("Beta", { exact: true })).toBeVisible();
    await expect(wayOut).toBeVisible();

    // Labelling is not enforcement: the control is genuinely unavailable too.
    await expect(toggle).toBeDisabled();
    await expect(controlPanel.getByText(/approved tester|tester access/i)).toHaveCount(0);

    await controlPanel.screenshot({
      path: "test-results/e2e/settings-beta-smart-context.png",
      fullPage: true,
      animations: "disabled",
    });

    await wayOut.click();
    await expectBetaFeaturesTab(controlPanel);
    await expect(betaSwitch(controlPanel)).toHaveAttribute("aria-pressed", "false");

    await betaSwitch(controlPanel).click();
    await expect(betaSwitch(controlPanel)).toHaveAttribute("aria-pressed", "true");

    // Back on General, the same row has lost its lock.
    await controlPanel
      .getByRole("main")
      .getByRole("button", { name: "General", exact: true })
      .click();
    await controlPanel.locator("summary").filter({ hasText: "More settings" }).click();
    await expect(toggle).toBeEnabled();
    await expect(row.getByText("Beta", { exact: true })).toHaveCount(0);
    await expect(wayOut).toHaveCount(0);
  });

  test("leads from a locked beta page to the switch, which unlocks it", async ({
    controlPanel,
  }) => {
    // AI Enhancement stays in the sidebar while locked, for its coding prompts.
    await controlPanel.getByRole("button", { name: "AI Enhancement", exact: true }).click();
    await expect(
      controlPanel.getByRole("heading", { name: "AI Enhancement", exact: true })
    ).toBeVisible();
    await expect(
      controlPanel.getByRole("heading", { name: "Dictation enhancement is in beta" })
    ).toBeVisible();

    // One word for the state. The header pill once said "Tester" while the
    // sidebar said "Beta".
    await expect(controlPanel.getByText("Tester", { exact: true })).toHaveCount(0);
    await expect(controlPanel.getByText(/approved tester|tester access/i)).toHaveCount(0);

    // Naming what the user is missing without offering a way to get it is
    // the worst of both options.
    const wayOut = controlPanel.getByRole("button", { name: WAY_OUT, exact: true });
    await expect(wayOut).toBeVisible();

    await controlPanel.screenshot({
      path: "test-results/e2e/beta-page-header.png",
      fullPage: true,
      animations: "disabled",
    });

    await wayOut.click();
    await expectBetaFeaturesTab(controlPanel);
    await expect(betaSwitch(controlPanel)).toHaveAttribute("aria-pressed", "false");
    await controlPanel.screenshot({
      path: "test-results/e2e/settings-beta-switch-off.png",
      fullPage: true,
      animations: "disabled",
    });

    await betaSwitch(controlPanel).click();
    await expect(betaSwitch(controlPanel)).toHaveAttribute("aria-pressed", "true");
    // The knob slides for 150ms after the attribute flips; finish it first.
    await controlPanel.screenshot({
      path: "test-results/e2e/settings-beta-switch-on.png",
      fullPage: true,
      animations: "disabled",
    });

    // No restart and no reload: the page follows the switch.
    await controlPanel.getByRole("button", { name: "AI Enhancement", exact: true }).click();
    await expect(
      controlPanel.getByRole("button", { name: "Enable AI enhancement", exact: true })
    ).toBeVisible();
    await expect(
      controlPanel.getByRole("heading", { name: "Dictation enhancement is in beta" })
    ).toHaveCount(0);
    await expect(controlPanel.getByRole("button", { name: WAY_OUT })).toHaveCount(0);
  });
});
