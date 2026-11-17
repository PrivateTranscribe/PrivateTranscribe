import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
import { evidenceDir } from "./fixtures/evidence";
import { unlockTesterAccess } from "./fixtures/tester-access";

/**
 * "Switch dictation mode" never switched anything: every command showed
 * "Dictation mode cleared", and the starter "Switch to Push-to-Talk" never
 * touched push-to-talk. It is hidden until it is decided what a mode is. An
 * action of that type saved earlier still shows, so the user can edit or
 * delete it.
 */

test.use({ experimentalFeatures: true });

test("the dictation mode action is offered nowhere", async ({ controlPanel: page }) => {
  const shots = evidenceDir("action-engine-hidden-mode");
  fs.mkdirSync(shots, { recursive: true });

  await unlockTesterAccess(page);
  await page.getByRole("button", { name: "Action Engine", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Search the Web/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Switch to Push-to-Talk/ })).toHaveCount(0);
  await page.screenshot({ path: path.join(shots, "templates.png"), animations: "disabled" });

  await page.getByRole("button", { name: "Add action", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New action" });
  await dialog.getByRole("combobox").filter({ hasText: "Shell command" }).click();
  await expect(page.getByRole("option", { name: "Open URL" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Switch dictation mode" })).toHaveCount(0);
  await page.screenshot({ path: path.join(shots, "type-list.png"), animations: "disabled" });
});

test("a dictation mode action saved earlier still shows and keeps its type", async ({
  controlPanel: page,
}) => {
  await unlockTesterAccess(page);
  await page.evaluate(() =>
    (window as any).electronAPI.actionEngineCreate({
      name: "Email voice",
      description: "",
      triggerPhrase: "email mode",
      triggerMode: "contains",
      actionType: "dictation-mode",
      actionConfig: { mode: "email" },
      enabled: true,
    })
  );
  await page.getByRole("button", { name: "Action Engine", exact: true }).click();
  await expect(page.getByText("Email voice", { exact: true })).toBeVisible();
  await expect(page.getByText("Switch dictation mode", { exact: true }).first()).toBeVisible();
});
