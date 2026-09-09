import fs from "node:fs";
import path from "node:path";
import { test, expect } from "./fixtures/electron-app";
import { seedShowcaseDatabase } from "./fixtures/showcase-data";

test("dashboard streak detail stays compact and accessible", async ({
  controlPanel: page,
  electronApp,
}) => {
  await seedShowcaseDatabase(electronApp);
  await page.reload();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByText("7 days", { exact: true })).toBeVisible();
  const dir = path.resolve("test-results/streak-preview");
  fs.mkdirSync(dir, { recursive: true });
  const tile = page.getByRole("button", { name: "Streak 7 days", exact: true });
  const tooltip = page.getByRole("tooltip");
  const card = page.locator("div.rounded-2xl").filter({ hasText: "Total words dictated" }).first();
  const bounds = await tile.boundingBox();
  await expect(tooltip).toHaveCount(0);
  await card.screenshot({ path: path.join(dir, "after-closed.png") });
  await tile.hover();
  await expect(tooltip).toHaveText("Longest streak: 7 days");
  expect(await tile.boundingBox()).toEqual(bounds);
  await card.screenshot({ path: path.join(dir, "after-hover.png") });
  await tooltip.hover();
  await expect(tooltip).toBeVisible();
  await page.getByRole("heading", { name: "Dashboard" }).hover();
  await expect(tooltip).toHaveCount(0);
  await tile.click();
  await expect(tooltip).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(tooltip).toBeVisible();
  await page.getByRole("heading", { name: "Dashboard" }).click();
  await expect(tooltip).toHaveCount(0);
  await tile.focus();
  await expect(tooltip).toBeVisible();
  await expect(tile).toHaveAttribute(
    "aria-describedby",
    (await tooltip.getAttribute("id")) as string
  );
  await card.screenshot({ path: path.join(dir, "after-keyboard.png") });
  await page.keyboard.press("Tab");
  await expect(tooltip).toHaveCount(0);

  await page.evaluate(() => window.electronAPI.resetStats());
  await page.reload();
  const emptyTile = page.getByRole("button", { name: "Streak 0 days", exact: true });
  await expect(emptyTile).toBeVisible();
  await card.screenshot({ path: path.join(dir, "after-empty-closed.png") });
  await emptyTile.click();
  await expect(tooltip).toHaveText("Longest streak: 0 days");
  await card.screenshot({ path: path.join(dir, "after-empty-open.png") });
});
