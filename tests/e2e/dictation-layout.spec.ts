import { expect, test } from "./fixtures/electron-app";
import { captureTab, disclosure } from "./fixtures/tab-layout";
const capture = captureTab;
test.use({ seedWhisperModels: ["base"] });

test("Dictation keeps controls and models visible and reveals optional settings", async ({
  controlPanel: page,
}) => {
  await page.evaluate(() => {
    localStorage.setItem("useLocalWhisper", "true");
    localStorage.setItem("whisperModel", "base");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Dictation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Controls", exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Show all models" })).toBeVisible();
  await expect(page.getByText("Base", { exact: true })).toBeVisible();
  await capture(page, "dictation-local");
  await page.getByRole("button", { name: "Show all models" }).click();
  await page.getByRole("button", { name: "Show fewer models" }).scrollIntoViewIfNeeded();
  await capture(page, "dictation-models-expanded");
  await page.getByRole("button", { name: "Show fewer models" }).click();
  const agent = disclosure(page, "Agent Mode");
  await expect(agent).toContainText("Unavailable");
  await agent.scrollIntoViewIfNeeded();
  await capture(page, "dictation-options");
  await agent.focus();
  await page.keyboard.press("Space");
  await expect(page.getByText("Agent Mode hotkey", { exact: true })).toBeVisible();
  await agent.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await capture(page, "agent-mode-open");
  await agent.click();
  await disclosure(page, "Local performance settings").click();
  await expect(page.getByRole("spinbutton", { name: "Whisper CPU thread count" })).toBeVisible();
  await disclosure(page, "Local performance settings").evaluate((el) =>
    el.scrollIntoView({ block: "start" })
  );
  await capture(page, "dictation-performance");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByPlaceholder(/Search settings/).fill("Agent Mode hotkey");
  await page.getByRole("option", { name: /Agent Mode hotkey/ }).click();
  await expect(disclosure(page, "Agent Mode").locator("..")).toHaveAttribute("open", "");
  await expect(page.getByText("Agent Mode hotkey", { exact: true })).toBeInViewport();
});
