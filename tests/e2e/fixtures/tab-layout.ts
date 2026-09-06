import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

// Reviewed evidence lives in docs/qa-tab-cleanup. Test runs never overwrite it.
export async function captureTab(page: Page, name: string) {
  const dir = path.resolve("test-results/qa-tab-cleanup");
  fs.mkdirSync(dir, { recursive: true });
  await page.mouse.move(1180, 780);
  await page.screenshot({ path: path.join(dir, `after-${name}.png`), animations: "disabled" });
}

export const disclosure = (page: Page, title: string) =>
  page.locator("summary").filter({ hasText: title });
