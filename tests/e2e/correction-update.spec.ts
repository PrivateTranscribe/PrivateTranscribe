import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";
import { evidenceDir } from "./fixtures/evidence";
import { enableBetaFeatures } from "./fixtures/tester-access";

/**
 * "Update correction" on the Correction Memory page promises that it "will
 * overwrite the current target". The database keeps one row per source and
 * target, so the update used to add a second row beside the old one. Both
 * stayed in the list, and the one confirmed more often kept winning.
 */

type CorrectionRow = { source: string; target: string; count: number; confirmed: number };

async function readCorrections(page: Page): Promise<CorrectionRow[]> {
  return (await page.evaluate(() =>
    (window as unknown as { electronAPI: any }).electronAPI.getCorrectionMemory(200)
  )) as CorrectionRow[];
}

async function saveCorrection(page: Page, source: string, target: string, button: string) {
  await page.getByPlaceholder("Source word - e.g. cloud").fill(source);
  await page.getByPlaceholder("Replacement word - e.g. Claude").fill(target);
  await page.getByRole("button", { name: button, exact: true }).click();
  await expect(page.getByPlaceholder("Source word - e.g. cloud")).toHaveValue("");
}

test("Update correction replaces the stored target instead of adding a second one", async ({
  controlPanel,
}) => {
  const shots = evidenceDir("correction-update");
  fs.mkdirSync(shots, { recursive: true });

  await enableBetaFeatures(controlPanel);
  await controlPanel.getByRole("button", { name: "Dictionary", exact: true }).click();
  await controlPanel.locator("summary").filter({ hasText: "Correction Memory" }).click();

  await saveCorrection(controlPanel, "cloud", "Claud", "Add correction");
  // Confirm the first target twice more, so it outranks a fresh row by count.
  // This is the case where the old row kept winning.
  await saveCorrection(controlPanel, "cloud", "Claud", "Update correction");
  await saveCorrection(controlPanel, "cloud", "Claud", "Update correction");
  expect((await readCorrections(controlPanel)).map((r) => r.target)).toEqual(["Claud"]);

  await controlPanel.getByPlaceholder("Source word - e.g. cloud").fill("cloud");
  await controlPanel.getByPlaceholder("Replacement word - e.g. Claude").fill("Claude");
  await expect(controlPanel.getByText("will overwrite the current target")).toBeVisible();
  await controlPanel.getByRole("button", { name: "Update correction", exact: true }).click();
  await expect(controlPanel.getByPlaceholder("Source word - e.g. cloud")).toHaveValue("");

  const stored = await readCorrections(controlPanel);
  expect(stored.map((r) => `${r.source}→${r.target}`)).toEqual(["cloud→Claude"]);
  expect(Boolean(stored[0].confirmed)).toBe(true);
  await expect(controlPanel.getByText("1 entry", { exact: true })).toBeVisible();

  await controlPanel.screenshot({
    path: path.join(shots, "after-update.png"),
    fullPage: true,
    animations: "disabled",
  });
});
