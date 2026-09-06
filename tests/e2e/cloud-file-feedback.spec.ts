import fs from "node:fs";
import path from "node:path";
import { cloudFile } from "./fixtures/cloud-file";
import { expect, test } from "./fixtures/electron-app";
const shots = path.resolve("test-results/qa-file-feedback");
const wav = path.resolve("tests/fixtures/multispeaker/control.wav");
test.beforeAll(() => {
  fs.mkdirSync(shots, { recursive: true });
});

test("cloud uses the file language and cancels its request", async ({
  controlPanel,
  electronApp,
}) => {
  await cloudFile(controlPanel, electronApp);
  await expect(controlPanel.getByText("Swedish", { exact: true })).toBeVisible();
  await expect(controlPanel.getByRole("checkbox", { name: /^Noise reduction/ })).toHaveCount(0);
  await expect(controlPanel.getByRole("checkbox", { name: /^Speaker labels/ })).toHaveCount(0);
  await controlPanel.screenshot({
    path: path.join(shots, "after-cloud.png"),
    animations: "disabled",
  });
  await controlPanel.getByRole("button", { name: "Settings Hide", exact: true }).click();
  await expect(controlPanel.getByRole("button", { name: "Swedish", exact: true })).toHaveCount(0);
  await controlPanel.screenshot({
    path: path.join(shots, "after-cloud-collapsed.png"),
    animations: "disabled",
  });
  await controlPanel.getByRole("button", { name: "Settings Show", exact: true }).click();
  await controlPanel.locator('input[type="file"]').setInputFiles(wav);
  await expect.poll(() => controlPanel.evaluate(() => (window as any).__sentLanguage)).toBe("sv");
  await controlPanel.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(() => controlPanel.evaluate(() => (window as any).__cloudAborted)).toBe(true);
  await expect(controlPanel.getByRole("heading", { name: "Cancelled", exact: true })).toBeVisible();
  await expect(controlPanel.getByRole("heading", { name: "Transcription failed" })).toHaveCount(0);
  await expect(
    controlPanel.getByText("Choose a file to start again.", { exact: true })
  ).toBeVisible();
  await controlPanel.screenshot({
    path: path.join(shots, "after-cancelled.png"),
    animations: "disabled",
  });
});

test("local file options remain available", async ({ controlPanel }) => {
  await controlPanel.evaluate(() => localStorage.setItem("useLocalWhisper", "true"));
  await controlPanel.reload({ waitUntil: "domcontentloaded" });
  await controlPanel.getByRole("button", { name: "Transcribe File", exact: true }).click();
  await expect(controlPanel.getByRole("checkbox", { name: /^Noise reduction/ })).toBeVisible();
  await expect(controlPanel.getByRole("checkbox", { name: /^Speaker labels/ })).toBeVisible();
  await controlPanel.screenshot({
    path: path.join(shots, "after-local.png"),
    animations: "disabled",
  });
});
