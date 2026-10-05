import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";

test.use({ useThrowawayHome: true });

async function openDictionary(page: Page) {
  await page.getByRole("button", { name: "Dictionary", exact: true }).click();
  const input = page.getByPlaceholder(/^e.g. PrivateTranscribe/);
  for (const word of [
    "Kubernetes",
    "Dr. Martinez",
    "TypeScript",
    "Electron",
    "Whisper",
    "Kokoro",
  ]) {
    await input.fill(word);
    await page.getByRole("button", { name: "Add", exact: true }).click();
  }
}

test("captures settings and dictionary layout evidence", async ({ controlPanel }, testInfo) => {
  await openDictionary(controlPanel);
  await controlPanel.evaluate(async () => {
    await document.fonts.ready;
  });
  await controlPanel.mouse.move(0, 0);
  await controlPanel.screenshot({
    path: testInfo.outputPath("dictionary.png"),
    animations: "disabled",
  });
  await controlPanel.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(controlPanel.getByText("Auto-paste transcription", { exact: true })).toBeVisible();
  await controlPanel.mouse.move(0, 0);
  await controlPanel.screenshot({
    path: testInfo.outputPath("settings.png"),
    animations: "disabled",
  });
});

test("dictionary fields and removal buttons have useful accessible names", async ({
  controlPanel,
}) => {
  await openDictionary(controlPanel);
  const input = controlPanel.getByRole("textbox", { name: "Add a word or phrase", exact: true });
  await expect(input).toHaveAccessibleDescription(
    "Type it exactly how you want it written. Press Enter to add."
  );
  await input.fill("ScreenReaderTerm");
  await input.press("Enter");
  await expect(
    controlPanel.getByRole("button", { name: "Remove ScreenReaderTerm", exact: true })
  ).toBeVisible();
  const filter = controlPanel.getByRole("textbox", {
    name: "Filter dictionary words",
    exact: true,
  });
  await filter.fill("Kubernetes");
  const remove = controlPanel.getByRole("button", { name: "Remove Kubernetes", exact: true });
  await remove.focus();
  await remove.press("Enter");
  await expect(remove).toHaveCount(0);
  await filter.fill("");
  await expect(
    controlPanel.getByRole("button", { name: "Remove ScreenReaderTerm", exact: true })
  ).toBeVisible();
});

test("settings switches expose their existing labels, descriptions and keyboard state", async ({
  controlPanel,
}) => {
  await controlPanel.getByRole("button", { name: "Settings", exact: true }).click();
  const toggle = controlPanel.getByRole("button", {
    name: "Auto-paste transcription",
    exact: true,
  });
  await expect(toggle).toHaveAccessibleDescription(
    "Paste into your text field when you finish speaking."
  );
  const original = await toggle.getAttribute("aria-pressed");
  await toggle.focus();
  await toggle.press("Space");
  await expect(toggle).toHaveAttribute("aria-pressed", original === "true" ? "false" : "true");
  await toggle.press("Enter");
  await expect(toggle).toHaveAttribute("aria-pressed", original!);
  await expect(
    controlPanel.getByRole("button", { name: "Copy to clipboard", exact: true })
  ).toBeVisible();
  await controlPanel.locator("summary").filter({ hasText: "More settings" }).click();
  await expect(
    controlPanel.getByRole("button", { name: "Mute my voice call while dictating", exact: true })
  ).toBeVisible();
  await controlPanel.getByRole("button", { name: "Dictionary", exact: true }).click();
  await controlPanel.locator("summary").filter({ hasText: "Dictionary settings" }).click();
  await expect(
    controlPanel.getByRole("button", { name: "Apply dictionary matching", exact: true })
  ).toHaveAccessibleDescription("Apply your spellings and saved corrections to dictation.");
});
