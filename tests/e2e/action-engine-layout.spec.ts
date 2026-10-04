import { expect, test } from "./fixtures/electron-app";
import { unlockTesterAccess } from "./fixtures/tester-access";
import { captureTab, disclosure } from "./fixtures/tab-layout";

test.use({ experimentalFeatures: true });

const capture = captureTab;
test("Action Engine has one create action and optional matching help", async ({
  controlPanel: page,
}) => {
  await unlockTesterAccess(page);
  await page.getByRole("button", { name: "Action Engine", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add action", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Create from scratch", exact: true })).toHaveCount(
    0
  );
  await capture(page, "action-engine");
  const matching = disclosure(page, "Trigger matching");
  await matching.click();
  await expect(page.getByText("The whole dictation must match.", { exact: true })).toBeVisible();
  await matching.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await capture(page, "action-help-open");
  await matching.click();
  await page.getByRole("button", { name: "Add action", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New action" })).toBeVisible();
  await capture(page, "action-form");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: /^Search the Web/ }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create action", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Search the Web", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add action", exact: true })).toHaveCount(1);
  await capture(page, "action-filled");
  await page.getByRole("switch", { name: "Disable Action Engine" }).click();
  await expect(
    page.getByText("Actions are paused. Dictation still works.", { exact: true })
  ).toBeVisible();
  await capture(page, "action-paused");
});

test("Action Engine keeps restricted controls locked", async ({ controlPanel: page }) => {
  await page.evaluate(async () => {
    await window.electronAPI.openControlPanel({ page: "action-engine" });
  });
  await expect(page.getByRole("heading", { name: "Action Engine", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start session" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add action", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("agent-name-input")).toHaveCount(0);
  await capture(page, "action-engine-locked");
});
