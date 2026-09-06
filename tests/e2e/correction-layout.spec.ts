import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
import { unlockTesterAccess } from "./fixtures/tester-access";

test("correction toggles keep their shape beside explanatory text", async ({ controlPanel }) => {
  const shots = path.resolve("docs/qa-correction-layout");
  fs.mkdirSync(shots, { recursive: true });
  await unlockTesterAccess(controlPanel);
  await controlPanel.getByRole("button", { name: "Dictionary", exact: true }).click();
  const heading = controlPanel.getByRole("heading", {
    name: "Learn corrections",
  });
  const card = heading.locator("xpath=../../..");
  const toggle = heading.locator("xpath=../..").getByRole("button");
  await card.scrollIntoViewIfNeeded();
  await expect(toggle).toHaveCSS("width", "32px");
  await card.screenshot({ path: path.join(shots, "after-off.png") });
  await toggle.click();
  await expect
    .poll(() => controlPanel.evaluate(() => localStorage.getItem("enableCorrectionLearning")))
    .toBe("true");
  await controlPanel.waitForTimeout(250);
  await card.screenshot({ path: path.join(shots, "after-on.png") });
  await expect(toggle).toHaveCSS("width", "32px");
  const track = await toggle.boundingBox();
  const thumb = await toggle.locator("span").boundingBox();
  expect(thumb!.width).toBe(14);
  expect(thumb!.x + thumb!.width).toBeLessThanOrEqual(track!.x + track!.width);
  for (const control of await card.getByRole("button").all()) {
    await expect(control).toHaveCSS("width", "32px");
  }
  await toggle.click();
  await expect
    .poll(() => controlPanel.evaluate(() => localStorage.getItem("enableCorrectionLearning")))
    .toBe("false");
  await expect(toggle).toHaveCSS("width", "32px");
});
