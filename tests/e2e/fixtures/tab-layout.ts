import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

// Screenshots for review land in the gitignored test-results/qa-tab-cleanup.
export async function captureTab(page: Page, name: string) {
  const dir = path.resolve("test-results/qa-tab-cleanup");
  fs.mkdirSync(dir, { recursive: true });
  await page.mouse.move(1180, 780);
  await page.screenshot({ path: path.join(dir, `after-${name}.png`), animations: "disabled" });
}

export const disclosure = (page: Page, title: string) =>
  page.locator("summary").filter({ hasText: title });
