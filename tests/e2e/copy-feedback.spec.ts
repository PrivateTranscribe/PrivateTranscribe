import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";
const shots = path.resolve("test-results/qa-everyday-feedback");
const transcript =
  "Send the revised proposal on Monday. Keep the introduction short and include the updated price.";
test.beforeAll(() => {
  fs.mkdirSync(shots, { recursive: true });
});
async function seed(page: Page) {
  await page.evaluate(async (text) => {
    await window.electronAPI.saveTranscription(text, 20);
  }, transcript);
  await expect(page.getByText(transcript, { exact: true })).toBeVisible();
}
for (const destination of ["Home", "History"]) {
  test(`${destination} only confirms copying after it succeeds`, async ({ controlPanel }) => {
    await seed(controlPanel);
    await controlPanel.getByRole("button", { name: destination, exact: true }).click();
    await controlPanel.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: (text: string) =>
          new Promise<void>((resolve, reject) => {
            (window as any).__copyText = text;
            (window as any).__finishCopy = resolve;
            (window as any).__failCopy = () => reject(new Error("Clipboard unavailable"));
          }),
      });
    });
    const copy = controlPanel.getByRole("button", { name: "Copy transcription", exact: true });
    await copy.focus();
    await expect(copy).toBeFocused();
    await expect(copy.locator("..")).toHaveCSS("opacity", "1");
    await controlPanel.keyboard.press("Enter");
    await expect(controlPanel.getByRole("button", { name: "Copying", exact: true })).toBeDisabled();
    await expect(controlPanel.getByRole("button", { name: "Copied", exact: true })).toHaveCount(0);
    await controlPanel.evaluate(() => (window as any).__failCopy());
    await expect(controlPanel.getByText("Copy failed", { exact: true })).toBeVisible();
    await expect(copy).toBeEnabled();
    await expect(controlPanel.getByRole("button", { name: "Copied", exact: true })).toHaveCount(0);
    await controlPanel.screenshot({
      path: path.join(shots, `after-${destination.toLowerCase()}-copy-failed.png`),
      animations: "disabled",
    });
    await copy.click();
    await controlPanel.evaluate(() => (window as any).__finishCopy());
    await expect(controlPanel.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
    await expect
      .poll(() => controlPanel.evaluate(() => (window as any).__copyText))
      .toBe(transcript);
    await expect(controlPanel.getByText("Transcription copied to clipboard")).toHaveCount(0);
    await controlPanel
      .getByText("Copy failed", { exact: true })
      .waitFor({ state: "hidden", timeout: 10_000 });
    await copy.click();
    await controlPanel.evaluate(() => (window as any).__finishCopy());
    await expect(controlPanel.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
    await controlPanel.screenshot({
      path: path.join(shots, `after-${destination.toLowerCase()}-copied.png`),
      animations: "disabled",
    });
  });
}
