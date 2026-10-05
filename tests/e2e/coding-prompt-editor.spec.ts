import path from "node:path";
import fs from "node:fs";
import { expect, test } from "./fixtures/electron-app";
import { unlockTesterAccess } from "./fixtures/tester-access";
import { disclosure } from "./fixtures/tab-layout";

test.use({
  useThrowawayHome: true,
  appEnv: { PRIVATETRANSCRIBE_DIAG_DISABLE_OVERLAY_WINDOW: "1" },
});

test("coding instructions save, persist, reset and stay separate from cleanup", async ({
  controlPanel: page,
  electronApp,
}) => {
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("model-get-all");
    ipcMain.handle("model-get-all", () => [
      { id: "qwen3.8-2b-distill-q4_k_m", isDownloaded: true },
    ]);
    ipcMain.removeHandler("process-local-reasoning");
    ipcMain.handle("process-local-reasoning", (_event, _text, _model, _agent, config) => ({
      success: true,
      text: config.customSystemPrompt,
    }));
  });
  await page.evaluate(() => {
    localStorage.setItem("reasoningProvider", "local");
    localStorage.setItem("reasoningModel", "qwen3.8-2b-distill-q4_k_m");
    localStorage.setItem("useReasoningModel", "true");
    localStorage.setItem(
      "customUnifiedPrompt",
      JSON.stringify("Keep the cleanup prompt separate.")
    );
  });
  await unlockTesterAccess(page);
  await page.getByRole("button", { name: "AI Enhancement", exact: true }).click();
  await page.getByRole("tab", { name: "Coding prompt", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Try a coding prompt" })).toBeVisible();
  const evidence = path.resolve("shots/coding-prompt");
  fs.mkdirSync(evidence, { recursive: true });
  await page.getByRole("heading", { name: "Try a coding prompt" }).scrollIntoViewIfNeeded();
  const capture = async (name: string) =>
    page.screenshot({ path: path.join(evidence, `after-${name}.png`) });
  await capture("coding-closed");
  await disclosure(page, "Coding prompt instructions").click();
  const editor = page.getByRole("textbox", { name: "Coding prompt instructions", exact: true });
  await expect(editor).toContainText("keeping the speaker's wording");
  await editor.scrollIntoViewIfNeeded();
  await capture("coding-open");
  await editor.fill("");
  await expect(page.getByRole("button", { name: "Save coding instructions" })).toBeDisabled();
  await capture("coding-empty");
  await editor.fill("Preserve my wording and technical details.");
  await page.getByRole("button", { name: "Save coding instructions" }).click();
  await expect(page.getByRole("status")).toContainText("Coding instructions saved");
  await page.getByRole("button", { name: "Try coding prompt", exact: true }).click();
  await expect(page.getByTestId("cleanup-result")).toContainText(
    "Preserve my wording and technical details."
  );
  await page.reload();
  await page.getByRole("button", { name: "AI Enhancement", exact: true }).click();
  await disclosure(page, "Coding prompt instructions").click();
  await expect(editor).toHaveValue("Preserve my wording and technical details.");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("customUnifiedPrompt")!))).toBe(
    "Keep the cleanup prompt separate."
  );
  await page.getByRole("button", { name: "Restore default" }).click();
  await expect(editor).toContainText("keeping the speaker's wording");
  expect(await page.evaluate(() => localStorage.getItem("customCodingPrompt"))).toBeNull();
  await page.getByRole("tab", { name: "Clean dictation", exact: true }).click();
  await expect(editor).toHaveCount(0);
});

test.describe("installed local model", () => {
  test.use({ useThrowawayHome: false });
  test("edits coding speech through the real local engine", async ({ controlPanel: page }) => {
    test.skip(process.env.PT_TEST_REAL_CODING !== "1", "Opt in to use the installed local model");
    await page.evaluate(() => {
      localStorage.setItem("reasoningProvider", "local");
      localStorage.setItem("reasoningModel", "qwen3.8-2b-distill-q4_k_m");
      localStorage.setItem("useReasoningModel", "true");
      localStorage.setItem("enhancementWritingStyle", "coding");
      localStorage.setItem(
        "customDictionary",
        JSON.stringify(["PrivateTranscribe", "Claude Code"])
      );
    });
    await unlockTesterAccess(page);
    await page.getByRole("button", { name: "AI Enhancement", exact: true }).click();
    const input = page.getByRole("textbox", { name: "Text to clean up" });
    for (const [name, text, expected] of [
      [
        "login-result",
        "uh fix the login button it does nothing after I reset my password the file is auth slash login dot ts",
        "auth/login.ts",
      ],
      ["request-result", "um write a Python function that adds two numbers", "Python function"],
      [
        "ordinary-speech",
        "I do not really see a way to change the coding prompt I do not know it is not really working as intended",
        "coding prompt",
      ],
    ]) {
      await input.fill(text);
      await page.getByRole("button", { name: "Try coding prompt", exact: true }).click();
      await expect(page.getByTestId("cleanup-result")).toContainText(expected, { timeout: 45000 });
      const output = await page.getByTestId("cleanup-result").innerText();
      expect(output).not.toMatch(/```|def main|Brief explanation|class PrivateTranscribe/);
      console.log(`${name}: ${output}`);
      fs.mkdirSync(path.resolve("shots/coding-prompt"), { recursive: true });
      await page.screenshot({ path: path.resolve(`shots/coding-prompt/after-${name}.png`) });
    }
  });
});
