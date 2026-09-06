import { expect, test } from "./fixtures/electron-app";
import { unlockTesterAccess } from "./fixtures/tester-access";
import { captureTab, disclosure } from "./fixtures/tab-layout";
const capture = captureTab;
test("AI setup leads with its switch and keeps advanced tools usable", async ({
  controlPanel: page,
}) => {
  await unlockTesterAccess(page);
  await page.getByRole("button", { name: "AI Enhancement", exact: true }).click();
  const toggle = page.getByRole("button", { name: "Enable AI enhancement", exact: true });
  await expect(toggle).toBeInViewport();
  await expect(toggle).toHaveCSS("width", "32px");
  await expect(page.getByTestId("agent-name-input")).toBeHidden();
  await expect(page.getByRole("button", { name: "Customize", exact: true })).toBeHidden();
  await capture(page, "ai-enhancement");
  await toggle.click();
  await expect(
    page.getByText("Sends transcription text to the selected provider.", { exact: true })
  ).toBeVisible();
  await capture(page, "ai-enabled");
  await expect(page.getByText("GPT-5.6 Luna", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Try cleanup" })).toBeVisible();
  await disclosure(page, "Advanced settings").click();
  const voice = disclosure(page, "Voice instructions");
  await voice.click();
  await page.getByTestId("agent-name-input").fill("Atlas");
  await page.getByTestId("agent-name-save").click();
  await page.getByRole("dialog").getByRole("button", { name: "OK", exact: true }).click();
  await expect(voice).toContainText("Hey Atlas");
  await voice.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await capture(page, "ai-voice-open");
  await voice.click();
  await disclosure(page, "Prompt tools").click();
  await page.getByRole("button", { name: "Customize", exact: true }).click();
  await disclosure(page, "Prompt tools").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await capture(page, "ai-prompt-open");
  const promptTools = disclosure(page, "Prompt tools");
  await expect(promptTools).toContainText("Default");
  await page
    .locator("textarea")
    .filter({ visible: true })
    .last()
    .fill("Use short, clear sentences.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "OK", exact: true }).click();
  await expect(promptTools).toContainText("Custom");
  await promptTools.click();
  await capture(page, "ai-custom-prompt");
  await promptTools.click();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "OK", exact: true }).click();
  await expect(promptTools).toContainText("Default");
});

test("AI Enhancement keeps restricted controls locked", async ({ controlPanel: page }) => {
  await page.evaluate(async () => {
    await window.electronAPI.openControlPanel({ page: "ai-enhancement" });
  });
  await expect(page.getByRole("heading", { name: "AI Enhancement", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start session" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add action", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("agent-name-input")).toHaveCount(0);
  await capture(page, "ai-enhancement-locked");
});

test("local AI performance options save without leaving the page", async ({
  controlPanel: page,
}) => {
  await page.evaluate(() => {
    localStorage.setItem("useReasoningModel", "true");
  });
  await unlockTesterAccess(page);
  await page.getByRole("button", { name: "AI Enhancement", exact: true }).click();
  await expect(disclosure(page, "Local performance settings")).toHaveCount(0);
  await page.getByRole("button", { name: "Local", exact: true }).click();
  await expect(page.getByText("Runs on this PC and works offline.", { exact: true })).toBeVisible();
  const options = disclosure(page, "Local performance settings");
  await expect(page.getByText("Qwen3.8 2B Distill", { exact: true })).toBeVisible();
  await expect(page.getByText("Qwen3 8B", { exact: true })).toBeHidden();
  await disclosure(page, "Advanced settings").click();
  const idle = page.getByRole("spinbutton", { name: "Llama server idle shutdown minutes" });
  await expect(idle).toBeHidden();
  await options.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await capture(page, "ai-local-options");
  await options.click();
  await idle.fill("7");
  await idle.press("Tab");
  await expect(options).toContainText("7 min");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("llamaServerIdleTimeoutMinutes")))
    .toBe("7");
  await capture(page, "ai-local-options-open");
});
