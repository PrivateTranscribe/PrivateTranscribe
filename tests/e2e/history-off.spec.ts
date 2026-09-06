import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
const shots = path.resolve("test-results/qa-everyday-feedback");
test.beforeAll(() => {
  fs.mkdirSync(shots, { recursive: true });
});

test("disabled history explains its state and can be enabled", async ({ controlPanel }) => {
  await controlPanel.evaluate(() => localStorage.setItem("historyLimit", "0"));
  await controlPanel.reload({ waitUntil: "domcontentloaded" });
  await expect(controlPanel.getByText("History is off", { exact: true })).toBeVisible();
  await controlPanel.getByText("History is off", { exact: true }).scrollIntoViewIfNeeded();
  await controlPanel.screenshot({
    path: path.join(shots, "after-home-history-off.png"),
    animations: "disabled",
  });
  await controlPanel.getByRole("button", { name: "History", exact: true }).click();
  await expect(controlPanel.getByText("History is off", { exact: true })).toBeVisible();
  await expect(controlPanel.getByText("No transcriptions yet", { exact: true })).toHaveCount(0);
  await controlPanel.screenshot({
    path: path.join(shots, "after-history-off.png"),
    animations: "disabled",
  });
  await controlPanel.getByRole("button", { name: "Turn on history", exact: true }).click();
  await expect
    .poll(() => controlPanel.evaluate(() => localStorage.getItem("historyLimit")))
    .toBe("50");
  await expect(controlPanel.getByText("No transcriptions yet", { exact: true })).toBeVisible();
  await controlPanel.screenshot({
    path: path.join(shots, "after-history-empty.png"),
    animations: "disabled",
  });
});
