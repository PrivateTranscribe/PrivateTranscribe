import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
import { unlockTesterAccess } from "./fixtures/tester-access";
import { disclosure } from "./fixtures/tab-layout";
import promptData from "../../src/config/promptData.json";

test.use({
  useThrowawayHome: true,
  appEnv: { PRIVATETRANSCRIBE_DIAG_DISABLE_OVERLAY_WINDOW: "1" },
});
test("single prompt keeps customization, resets, and ignores removed profile settings", async ({
  controlPanel: page,
  electronApp,
}) => {
  const evidence = process.env.PT_PROMPT_EVIDENCE_DIR || path.resolve("test-results/single-prompt");
  fs.mkdirSync(evidence, { recursive: true });
  const capture = async (name: string) =>
    page.screenshot({ path: path.join(evidence, `after-${name}.png`), animations: "disabled" });
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("model-get-all");
    ipcMain.handle("model-get-all", () => [
      { id: "qwen3.8-2b-distill-q4_k_m", isDownloaded: true },
    ]);
    ipcMain.removeHandler("process-local-reasoning");
    ipcMain.handle("process-local-reasoning", (_event, _text, _model, _name, config) => {
      (globalThis as any).__lastSinglePrompt = config.customSystemPrompt;
      return { success: true, text: "" };
    });
  });
  await page.evaluate(() => {
    localStorage.setItem("useReasoningModel", "true");
    localStorage.setItem("reasoningProvider", "local");
    localStorage.setItem("reasoningModel", "qwen3.8-2b-distill-q4_k_m");
    localStorage.setItem(
      "customUnifiedPrompt",
      JSON.stringify("Keep the original saved customization.")
    );
    localStorage.setItem("enhancementPromptProfile", "experimental");
    localStorage.setItem(
      "experimentalUnifiedPrompt",
      JSON.stringify("Obsolete experimental prompt.")
    );
    localStorage.setItem("enhancementWritingStyle", "Obsolete writing preferences.");
  });
  await unlockTesterAccess(page);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: /^AI Enhancement/ })
    .click();
  await expect(page.getByRole("button", { name: "Compare both prompts", exact: true })).toHaveCount(
    0
  );
  await capture("closed");
  await page.getByRole("textbox", { name: "Text to clean up" }).fill("year");
  await page.getByRole("button", { name: "Try cleanup", exact: true }).click();
  await expect(page.getByTestId("cleanup-result")).toHaveText("year");
  const sent = await electronApp.evaluate(() => (globalThis as any).__lastSinglePrompt);
  expect(sent).toContain("Keep the original saved customization.");
  expect(sent).not.toContain("Obsolete");
  await disclosure(page, "Advanced settings").click();
  await disclosure(page, "Prompt tools").click();
  await expect(page.getByRole("combobox", { name: "Dictation prompt" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Experimental writing style" })).toHaveCount(0);
  await page.getByRole("button", { name: "Customize", exact: true }).click();
  const editor = page.getByPlaceholder("Enter your custom system prompt...");
  await expect(editor).toHaveValue("Keep the original saved customization.");
  await editor.scrollIntoViewIfNeeded();
  await capture("editor");
  await editor.fill("My revised single prompt.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "OK", exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("customUnifiedPrompt")!))).toBe(
    "My revised single prompt."
  );
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await expect(editor).toHaveValue(promptData.UNIFIED_SYSTEM_PROMPT);
  await capture("reset");
});
