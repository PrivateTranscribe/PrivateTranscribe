import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { BETA_FEATURES_KEY } from "../../../src/utils/betaFeatures";

const turnOnSwitch = (page: Page) =>
  page.evaluate((key) => localStorage.setItem(key, "true"), BETA_FEATURES_KEY);

/** Whether the Beta features switch is on, as this window reads it. */
export async function isBetaFeaturesOn(page: Page): Promise<boolean> {
  return (await page.evaluate((key) => localStorage.getItem(key), BETA_FEATURES_KEY)) === "true";
}

/**
 * Turn on the Beta features switch, stored where the Settings toggle keeps it.
 *
 * Every window of the app shares one localStorage, so the dictation overlay
 * reads the same value. The reload makes this window render with it on, and it
 * drops anything a spec installed on `window` before, so call this first.
 */
export async function enableBetaFeatures(controlPanel: Page): Promise<void> {
  await turnOnSwitch(controlPanel);
  await controlPanel.reload({ waitUntil: "domcontentloaded" });

  await expect(controlPanel.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  expect(
    await isBetaFeaturesOn(controlPanel),
    "the app turned the beta switch back off while loading"
  ).toBe(true);
}

/**
 * Turn the switch on for the dictation overlay, where dictation completes.
 *
 * The reload also restarts the overlay on the settings the spec wrote just
 * before, so it cannot dictate with what it loaded at launch.
 */
export async function enableBetaFeaturesInOverlay(overlay: Page): Promise<void> {
  await turnOnSwitch(overlay);
  await overlay.reload({ waitUntil: "domcontentloaded" });
  await expect(overlay.getByRole("button", { name: "Dictation overlay" })).toBeVisible();
}

/** The name the specs written for the old tester licence still call. */
export const unlockTesterAccess = enableBetaFeatures;

/**
 * The switch lives in the profile and survives a restart, so there is no
 * licence race to clear first any more: this is the same as turning it on.
 */
export const unlockTesterAccessAfterRestart = enableBetaFeatures;
