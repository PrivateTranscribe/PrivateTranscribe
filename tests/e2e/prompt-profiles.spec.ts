import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
import { unlockTesterAccess, unlockTesterAccessAfterRestart } from "./fixtures/tester-access";
import { disclosure } from "./fixtures/tab-layout";
import promptData from "../../src/config/promptData.json";

const modelId = "qwen3.8-2b-distill-q4_k_m";
const evidence = process.env.PT_PROMPT_EVIDENCE_DIR || path.resolve("test-results/prompt-profiles");
async function capture(page: import("@playwright/test").Page, name: string) {
  fs.mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: path.join(evidence, `after-${name}.png`), animations: "disabled" });
}
test.use({
  useThrowawayHome: true,
  appEnv: { PRIVATETRANSCRIBE_DIAG_DISABLE_OVERLAY_WINDOW: "1" },
});

test("profiles preserve the baseline, compare identical inputs, and keep short dictation", async ({
  controlPanel: page,
  electronApp,
  relaunchElectronApp,
}) => {
  await page.getByRole("button", { name: "Beta features", exact: true }).click();
  await page.getByRole("button", { name: /^AI Enhancement/ }).click();
  await expect(page.getByRole("combobox", { name: "Dictation prompt" })).toHaveCount(0);
  await capture(page, "locked");
  await electronApp.evaluate(({ ipcMain }, id) => {
    (globalThis as any).__profileRequests = [];
    ipcMain.removeHandler("model-get-all");
    ipcMain.handle("model-get-all", () => [{ id, isDownloaded: true }]);
    ipcMain.removeHandler("process-local-reasoning");
    ipcMain.handle("process-local-reasoning", async (_event, text, model, _name, config) => {
      (globalThis as any).__profileRequests.push({ text, model, config });
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { success: true, text: text === "Thank you" ? "" : text };
    });
  }, modelId);
  await page.evaluate(
    ({ id, baseline }) => {
      localStorage.setItem("useReasoningModel", "true");
      localStorage.setItem("reasoningProvider", "local");
      localStorage.setItem("reasoningModel", id);
      localStorage.setItem("preferredLanguage", "auto");
      localStorage.setItem("customUnifiedPrompt", JSON.stringify(baseline));
    },
    { id: modelId, baseline: promptData.UNIFIED_SYSTEM_PROMPT }
  );
  await unlockTesterAccess(page);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: /^AI Enhancement/ })
    .click();
  const selector = page.getByRole("combobox", { name: "Dictation prompt" });
  await expect(selector).toBeHidden();
  await capture(page, "prompt-tools-closed");
  await disclosure(page, "Advanced settings").click();
  await disclosure(page, "Prompt tools").click();
  await expect(selector).toHaveText("Current prompt");
  await selector.scrollIntoViewIfNeeded();
  await capture(page, "current");
  await selector.click();
  await expect(
    page.getByRole("option", { name: "Experimental prompt", exact: true })
  ).toBeVisible();
  await capture(page, "selector-open");
  await page.getByRole("option", { name: "Experimental prompt", exact: true }).click();
  await disclosure(page, "Writing style").click();
  await page
    .getByRole("textbox", { name: "Experimental writing style" })
    .fill("Use short sentences and ordinary words.");
  await capture(page, "experimental-style");
  await disclosure(page, "Writing style").click();
  const input = page.getByRole("textbox", { name: "Text to clean up" });
  await input.fill("Maybe we should try profiles. I am not sure yet.");
  await page.getByRole("button", { name: "Compare both prompts", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Compare both prompts", exact: true })
  ).toBeDisabled();
  await expect(page.getByTestId("comparison-result")).toHaveCount(2);
  const requests = await electronApp.evaluate(() => (globalThis as any).__profileRequests);
  expect(requests).toHaveLength(2);
  expect(requests[0].text).toBe(requests[1].text);
  expect(requests[0].model).toBe(requests[1].model);
  expect(requests[0].config.customSystemPrompt).not.toContain("EXPERIMENTAL EDITING PROFILE");
  expect(requests[0].config.customSystemPrompt).not.toContain(
    "Use short sentences and ordinary words."
  );
  expect(requests[1].config.customSystemPrompt).toContain("EXPERIMENTAL EDITING PROFILE");
  expect(requests[1].config.customSystemPrompt).toContain(
    "Use short sentences and ordinary words."
  );
  await expect(selector).toHaveText("Experimental prompt");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("customUnifiedPrompt")!))).toBe(
    promptData.UNIFIED_SYSTEM_PROMPT
  );
  await page.getByTestId("comparison-result").last().scrollIntoViewIfNeeded();
  await capture(page, "comparison");
  await input.fill("Thank you");
  await page.getByRole("button", { name: "Try cleanup", exact: true }).click();
  await expect(page.getByTestId("cleanup-result")).toHaveText("Thank you");
  await expect(page.getByText("Kept as spoken · no model call")).toBeVisible();
  expect(await electronApp.evaluate(() => (globalThis as any).__profileRequests.length)).toBe(2);
  await capture(page, "short-dictation");
  await input.fill("");
  await expect(page.getByTestId("cleanup-result")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Compare both prompts", exact: true })
  ).toBeDisabled();
  await capture(page, "empty");
  await page.getByRole("button", { name: "Customize", exact: true }).click();
  const editor = page.getByPlaceholder("Enter your custom system prompt...");
  await expect(editor).toContainText(/SHORT DICTATION/);
  await editor.fill("My experimental instructions for {{agentName}}.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await selector.click();
  await page.getByRole("option", { name: "Current prompt", exact: true }).click();
  await expect(editor).toHaveValue(promptData.UNIFIED_SYSTEM_PROMPT);
  await selector.click();
  await page.getByRole("option", { name: "Experimental prompt", exact: true }).click();
  await expect(editor).toHaveValue("My experimental instructions for {{agentName}}.");
  await editor.scrollIntoViewIfNeeded();
  await capture(page, "experimental-editor");
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await expect(editor).toHaveValue(/SHORT DICTATION/);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("customUnifiedPrompt")!))).toBe(
    promptData.UNIFIED_SYSTEM_PROMPT
  );
  const restarted = await relaunchElectronApp();
  const freshPage = restarted.controlPanel;
  await unlockTesterAccessAfterRestart(freshPage);
  await freshPage
    .getByRole("navigation")
    .getByRole("button", { name: /^AI Enhancement/ })
    .click();
  await disclosure(freshPage, "Advanced settings").click();
  await disclosure(freshPage, "Prompt tools").click();
  await expect(freshPage.getByRole("combobox", { name: "Dictation prompt" })).toHaveText(
    "Experimental prompt"
  );
  await disclosure(freshPage, "Writing style").click();
  await expect(freshPage.getByRole("textbox", { name: "Experimental writing style" })).toHaveValue(
    "Use short sentences and ordinary words."
  );
  await restarted.electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().includes("panel=true"))
      ?.setSize(960, 760);
  });
  await freshPage.getByRole("combobox", { name: "Dictation prompt" }).scrollIntoViewIfNeeded();
  await capture(freshPage, "small-window");
  expect(
    await freshPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
  ).toBe(true);
});

test("comparison shows provider errors and discards results after a profile change", async ({
  controlPanel: page,
  electronApp,
}) => {
  await electronApp.evaluate(({ ipcMain }, id) => {
    ipcMain.removeHandler("model-get-all");
    ipcMain.handle("model-get-all", () => [{ id, isDownloaded: true }]);
    ipcMain.removeHandler("process-local-reasoning");
    ipcMain.handle("process-local-reasoning", async (_event, _text, _model, _name, config) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return config.customSystemPrompt.includes("EXPERIMENTAL EDITING PROFILE")
        ? { success: false, error: "Test provider unavailable" }
        : { success: true, text: "Original result" };
    });
  }, modelId);
  await page.evaluate((id) => {
    localStorage.setItem("useReasoningModel", "true");
    localStorage.setItem("reasoningProvider", "local");
    localStorage.setItem("reasoningModel", id);
  }, modelId);
  await unlockTesterAccess(page);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: /^AI Enhancement/ })
    .click();
  await disclosure(page, "Advanced settings").click();
  await disclosure(page, "Prompt tools").click();
  await page.getByRole("button", { name: "Compare both prompts", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Test provider unavailable");
  await page.getByRole("alert").scrollIntoViewIfNeeded();
  await capture(page, "comparison-error");
  await page.getByRole("button", { name: "Compare both prompts", exact: true }).click();
  await page.getByRole("combobox", { name: "Dictation prompt" }).click();
  await page.getByRole("option", { name: "Experimental prompt", exact: true }).click();
  await expect(page.getByRole("button", { name: "Try cleanup", exact: true })).toBeEnabled();
  await expect(page.getByTestId("comparison-result")).toHaveCount(0);
  await expect(page.getByTestId("cleanup-result")).toHaveCount(0);
});
