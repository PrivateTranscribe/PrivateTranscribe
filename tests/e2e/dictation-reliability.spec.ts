import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
import { unlockTesterAccess } from "./fixtures/tester-access";

const shots = path.resolve("docs/qa-0.17.1");
const phase = "after";

test("dictation settings explain optional correction learning", async ({ controlPanel }) => {
  fs.mkdirSync(shots, { recursive: true });
  await controlPanel.getByRole("button", { name: "Dictionary", exact: true }).click();
  await controlPanel
    .getByRole("heading", { name: "Correction Memory", exact: true })
    .scrollIntoViewIfNeeded();
  await controlPanel.screenshot({ path: path.join(shots, `${phase}-corrections-locked.png`) });

  await unlockTesterAccess(controlPanel);
  await controlPanel.getByRole("button", { name: "Dictionary", exact: true }).click();
  const learning = controlPanel.getByRole("heading", {
    name: "Suggest corrections from copied edits",
  });
  await learning.scrollIntoViewIfNeeded();
  await controlPanel.screenshot({ path: path.join(shots, `${phase}-corrections-off.png`) });
  const toggle = learning.locator("xpath=../..").getByRole("button");
  await toggle.click();
  await expect
    .poll(() => controlPanel.evaluate(() => localStorage.getItem("enableCorrectionLearning")))
    .toBe("true");
  await controlPanel.waitForTimeout(200);
  await controlPanel.screenshot({ path: path.join(shots, `${phase}-corrections-on.png`) });
  await toggle.click();
  await expect
    .poll(() => controlPanel.evaluate(() => localStorage.getItem("enableCorrectionLearning")))
    .toBe("false");
  await controlPanel.waitForTimeout(200);

  await controlPanel.getByPlaceholder(/Source word/).fill("cloud");
  await controlPanel.getByPlaceholder(/Replacement word/).fill("Claude");
  await controlPanel.getByRole("button", { name: "Add correction", exact: true }).click();
  await expect(controlPanel.getByRole("button", { name: "Remove correction" })).toBeVisible();
  await controlPanel.screenshot({ path: path.join(shots, `${phase}-corrections-saved.png`) });

  await controlPanel.getByRole("button", { name: "Settings", exact: true }).click();
  await controlPanel.getByRole("button", { name: "General", exact: true }).click();
  await controlPanel
    .getByText("Auto-paste transcription", { exact: true })
    .scrollIntoViewIfNeeded();
  await controlPanel.screenshot({ path: path.join(shots, `${phase}-delivery-settings.png`) });
  await controlPanel.getByText("Success confirmation", { exact: true }).scrollIntoViewIfNeeded();
  await controlPanel.screenshot({ path: path.join(shots, `${phase}-notification-settings.png`) });
});
