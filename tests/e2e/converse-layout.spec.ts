import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
import { unlockTesterAccess } from "./fixtures/tester-access";
import { captureTab, disclosure } from "./fixtures/tab-layout";
const capture = captureTab;

test.use({ useThrowawayHome: true });
test("Converse keeps Start visible and reveals voice preferences", async ({
  controlPanel: page,
}) => {
  await page.evaluate(() => localStorage.setItem("converseVoiceEnabled", "true"));
  await page.evaluate(
    (folder) =>
      localStorage.setItem(
        "converseProjects",
        JSON.stringify([{ path: folder, lastUsedAt: Date.now() }])
      ),
    path.resolve("tests/fixtures")
  );
  await unlockTesterAccess(page);
  await page.getByRole("button", { name: "Converse", exact: true }).click();
  await page.getByTestId("converse-recent-project").click();
  await expect(page.getByRole("button", { name: "Start session" })).toBeInViewport();
  await expect(page.getByTestId("converse-speech-route")).toBeVisible();
  await expect(page.getByTestId("converse-end-of-turn-select")).toBeHidden();
  await capture(page, "converse-setup");
  const voice = disclosure(page, "Voice options");
  await expect(voice).toContainText("Voice not installed");
  await voice.click();
  await expect(page.getByTestId("converse-end-of-turn-select")).toBeVisible();
  const mute = page
    .locator('[data-settings-label="Mute microphone during replies"]')
    .getByRole("button");
  await expect(page.getByText(/Use headphones so replies/)).toBeHidden();
  await mute.click();
  await expect(page.getByText(/Use headphones so replies/)).toBeVisible();
  await voice.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await capture(page, "converse-voice-open");
  await voice.click();
  await expect(page.getByRole("button", { name: "Start session" })).toBeInViewport();
});

test("Converse keeps restricted controls locked", async ({ controlPanel: page }) => {
  await page.evaluate(async () => {
    await window.electronAPI.openControlPanel({ page: "converse" });
  });
  await expect(page.getByRole("heading", { name: "Converse", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start session" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add action", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("agent-name-input")).toHaveCount(0);
  await capture(page, "converse-locked");
});

test.describe("installed voice selection", () => {
  test.use({ seedKokoroModel: true });
  test("keeps the selected voice compact and allows changes", async ({ controlPanel: page }) => {
    await page.evaluate(
      (folder) =>
        localStorage.setItem(
          "converseProjects",
          JSON.stringify([{ path: folder, lastUsedAt: Date.now() }])
        ),
      path.resolve("tests/fixtures")
    );
    await unlockTesterAccess(page);
    await page.getByRole("button", { name: "Converse", exact: true }).click();
    await page.getByTestId("converse-recent-project").click();
    const voice = disclosure(page, "Voice options");
    await expect(voice).toContainText("Voice ready");
    await voice.click();
    await expect(page.getByTestId("converse-voice-list")).toBeHidden();
    await expect(page.getByText(/Also used in Read Aloud/)).toBeVisible();
    await voice.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await capture(page, "converse-voice-installed");
    await page.getByRole("button", { name: "Change voice", exact: true }).click();
    const voices = page.getByTestId("converse-voice-list");
    await expect(voices).toBeVisible();
    await capture(page, "converse-voices-expanded");
    const choice = voices.getByRole("radio").nth(1);
    await choice.click();
    await expect(choice).toHaveAttribute("aria-checked", "true");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(voices).toBeHidden();
  });
});
