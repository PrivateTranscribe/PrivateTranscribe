import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
import { unlockTesterAccess } from "./fixtures/tester-access";

const shots = path.resolve("docs/qa-settings-clarity");
test.beforeAll(() => {
  fs.mkdirSync(shots, { recursive: true });
});

test("everyday settings come first and navigation starts at the top", async ({ controlPanel }) => {
  await controlPanel.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    controlPanel.getByText("Auto-paste transcription", { exact: true })
  ).toBeInViewport();
  await expect(controlPanel.getByText("Smart Context", { exact: true })).toBeHidden();
  await expect(controlPanel.getByText("Unpacked build", { exact: true })).toBeVisible();
  await controlPanel.screenshot({
    path: path.join(shots, "after-general.png"),
    animations: "disabled",
  });
  const more = controlPanel.locator("summary").filter({ hasText: "More settings" });
  await more.scrollIntoViewIfNeeded();
  await controlPanel.screenshot({
    path: path.join(shots, "after-more-closed.png"),
    animations: "disabled",
  });
  await more.focus();
  await controlPanel.keyboard.press("Space");
  await expect(more.locator("..")).toHaveAttribute("open", "");
  await controlPanel.getByText("Snap overlay to taskbar", { exact: true }).scrollIntoViewIfNeeded();
  await controlPanel.screenshot({
    path: path.join(shots, "after-more-open.png"),
    animations: "disabled",
  });
  await expect(controlPanel.getByText("GPU speed-up", { exact: true })).toBeVisible();
  await controlPanel.getByRole("button", { name: "Dictionary", exact: true }).click();
  await expect(
    controlPanel.getByRole("heading", { name: "Dictionary", exact: true })
  ).toBeInViewport();
  await expect.poll(() => controlPanel.locator("main").evaluate((main) => main.scrollTop)).toBe(0);
});

test("Dictionary keeps optional tools compact and retains learning state", async ({
  controlPanel,
}) => {
  await controlPanel.getByRole("button", { name: "Dictionary", exact: true }).click();
  const corrections = controlPanel.locator("summary").filter({ hasText: "Correction Memory" });
  await controlPanel.getByRole("button", { name: "Remove word", exact: true }).click();
  await expect(controlPanel.getByText("No words added yet")).toBeVisible();
  await expect(corrections.getByText("Beta", { exact: true })).toBeVisible();
  await controlPanel.screenshot({
    path: path.join(shots, "after-dictionary-empty.png"),
    animations: "disabled",
  });
  await controlPanel.getByPlaceholder(/^e.g. PrivateTranscribe/).fill("PrivateTranscribe");
  await controlPanel.getByRole("button", { name: "Add", exact: true }).click();
  await corrections.click();
  await expect(controlPanel.getByRole("button", { name: "Apply for beta access" })).toBeVisible();
  await controlPanel.screenshot({
    path: path.join(shots, "after-dictionary-locked.png"),
    animations: "disabled",
  });
  const dictionarySettings = controlPanel
    .locator("summary")
    .filter({ hasText: "Dictionary settings" });
  await dictionarySettings.click();
  await controlPanel
    .getByText("Apply dictionary matching", { exact: true })
    .scrollIntoViewIfNeeded();
  await controlPanel.screenshot({
    path: path.join(shots, "after-dictionary-settings.png"),
    animations: "disabled",
  });
  await unlockTesterAccess(controlPanel);
  await controlPanel.getByRole("button", { name: "Dictionary", exact: true }).click();
  await expect(corrections.getByText("Learning off")).toBeVisible();
  await corrections.click();
  const learning = controlPanel.getByRole("heading", { name: "Learn corrections", exact: true });
  await learning.scrollIntoViewIfNeeded();
  const toggle = learning.locator("xpath=../..").getByRole("button");
  await expect(toggle).toHaveCSS("width", "32px");
  await controlPanel.screenshot({
    path: path.join(shots, "after-corrections-off.png"),
    animations: "disabled",
  });
  await toggle.click();
  await expect(corrections.getByText("Learning on")).toBeVisible();
  await controlPanel.screenshot({
    path: path.join(shots, "after-corrections-on.png"),
    animations: "disabled",
  });
  await corrections.click();
  await expect(corrections.getByText("Learning on")).toBeVisible();
  await expect(learning).toBeHidden();
  await controlPanel.screenshot({
    path: path.join(shots, "after-dictionary-full.png"),
    animations: "disabled",
  });
  await corrections.click();
  await controlPanel.getByPlaceholder(/Source word/).fill("cloud");
  await controlPanel.getByPlaceholder(/Replacement word/).fill("Claude");
  await controlPanel.getByRole("button", { name: "Add correction", exact: true }).click();
  await expect(controlPanel.getByRole("button", { name: "Remove correction" })).toBeVisible();
  await controlPanel.screenshot({
    path: path.join(shots, "after-corrections-saved.png"),
    animations: "disabled",
  });
  await controlPanel.getByRole("button", { name: "Edit correction" }).click();
  await expect(controlPanel.getByPlaceholder(/Source word/)).toHaveValue("cloud");
  await expect(controlPanel.getByPlaceholder(/Replacement word/)).toBeInViewport();
});

test("search opens optional settings on this page and another page", async ({ controlPanel }) => {
  await controlPanel.getByRole("button", { name: "Settings", exact: true }).click();
  const search = controlPanel.getByRole("searchbox", { name: "Search settings" });
  await search.fill("smart context");
  await controlPanel.getByRole("option", { name: /Smart Context/ }).click();
  const context = controlPanel.locator('[data-settings-label="Smart Context"]');
  await expect(context).toBeInViewport();
  await expect(context).toHaveClass(/settings-row-found/);
  await controlPanel.screenshot({
    path: path.join(shots, "after-search-context.png"),
    animations: "disabled",
  });
  await search.fill("corrections");
  await controlPanel.getByRole("option", { name: /Correction Memory/ }).click();
  const result = controlPanel.locator('summary[data-settings-label="Correction Memory"]');
  await expect(result).toBeInViewport();
  await expect(result.locator("..")).toHaveAttribute("open", "");
  await expect(controlPanel.getByRole("button", { name: "Apply for beta access" })).toBeVisible();
});

test("build type and beta access have separate labels", async ({ controlPanel }) => {
  await controlPanel.getByRole("button", { name: "Beta features", exact: true }).click();
  await expect(controlPanel.getByRole("button", { name: "Pro & Beta", exact: true })).toBeVisible();
  await expect(controlPanel.getByText("Unpacked build", { exact: true })).toBeVisible();
  await controlPanel.screenshot({
    path: path.join(shots, "after-access.png"),
    animations: "disabled",
  });
  await controlPanel
    .getByText("Beta access is separate from Pro and requires tester approval.")
    .scrollIntoViewIfNeeded();
  await controlPanel.screenshot({
    path: path.join(shots, "after-access-beta.png"),
    animations: "disabled",
  });
  await controlPanel.getByRole("button", { name: /^Correction Memory/ }).click();
  const corrections = controlPanel.locator('summary[data-settings-label="Correction Memory"]');
  await expect(corrections.locator("..")).toHaveAttribute("open", "");
  await expect(corrections).toBeInViewport();
  await expect(controlPanel.getByRole("button", { name: "Apply for beta access" })).toBeVisible();
});

test("enabled app context remains visible in the closed section", async ({ controlPanel }) => {
  await unlockTesterAccess(controlPanel);
  await controlPanel.getByRole("button", { name: "General", exact: true }).click();
  const more = controlPanel.locator("summary").filter({ hasText: "More settings" });
  await more.click();
  const context = controlPanel.locator('[data-settings-label="Smart Context"]');
  await context.getByRole("button").click();
  await expect(
    controlPanel.getByText("What Smart Context reads, and what it protects")
  ).toBeVisible();
  await context.scrollIntoViewIfNeeded();
  await controlPanel.screenshot({
    path: path.join(shots, "after-context-on.png"),
    animations: "disabled",
  });
  await more.click();
  await expect(more).toContainText("App context on");
  await controlPanel.screenshot({
    path: path.join(shots, "after-context-closed.png"),
    animations: "disabled",
  });
});
