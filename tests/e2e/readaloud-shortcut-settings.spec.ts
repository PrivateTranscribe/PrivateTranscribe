import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
import { unlockTesterAccess, unlockTesterAccessAfterRestart } from "./fixtures/tester-access";

const evidence = path.resolve("test-results/qa-readaloud-shortcuts");
test.use({ useThrowawayHome: true });
test.describe("installed voice model", () => {
  test.use({ seedKokoroModel: true });
  test("Read Aloud shortcut settings", async ({ controlPanel }) => {
    fs.mkdirSync(evidence, { recursive: true });
    await unlockTesterAccess(controlPanel);
    await controlPanel.getByRole("button", { name: /^Read Aloud( Beta)?$/ }).click();
    const field = controlPanel.getByRole("button", { name: "Read Aloud hotkey", exact: true });
    await expect(field).toBeEnabled();
    await expect(field).toContainText("Alt");
    await expect(field).toContainText("Ctrl");
    const shortcuts = controlPanel.getByTestId("readaloud-playback-shortcuts");
    await shortcuts.scrollIntoViewIfNeeded();
    await controlPanel.screenshot({ path: path.join(evidence, "after-defaults.png") });
    const pause = controlPanel.getByRole("button", { name: "Pause or resume hotkey" });
    await pause.click();
    await expect(pause).toContainText("Recording");
    await shortcuts.screenshot({ path: path.join(evidence, "after-recording.png") });
    await pause.click({ button: "middle" });
    await expect(controlPanel.getByTestId("hotkey-conflict")).toHaveText(
      "Use a keyboard key, with optional modifiers"
    );
    await controlPanel.keyboard.press("Control+Alt+R");
    await expect(controlPanel.getByTestId("hotkey-conflict")).toHaveText(
      "Already used by Read Aloud"
    );
    await shortcuts.screenshot({ path: path.join(evidence, "after-conflict.png") });
    await controlPanel.keyboard.press("Escape");
    await expect(pause).toContainText("Space");
    for (const [name, key] of [
      ["Pause or resume", "F8"],
      ["Previous sentence", "F9"],
      ["Next sentence", "F10"],
    ]) {
      await controlPanel.getByRole("button", { name: `${name} hotkey` }).click();
      await controlPanel.keyboard.press(key);
      await expect(controlPanel.getByRole("button", { name: `${name} hotkey` })).toContainText(key);
    }
    await shortcuts.screenshot({ path: path.join(evidence, "after-custom.png") });
    await unlockTesterAccessAfterRestart(controlPanel);
    await controlPanel.getByRole("button", { name: /^Read Aloud( Beta)?$/ }).click();
    await expect(pause).toContainText("F8");
    await expect(
      controlPanel.getByRole("button", { name: "Previous sentence hotkey" })
    ).toContainText("F9");
    await expect(controlPanel.getByRole("button", { name: "Next sentence hotkey" })).toContainText(
      "F10"
    );
    await pause.click();
    await controlPanel.keyboard.press("Backspace");
    await expect(pause).toContainText("Space");
    await expect
      .poll(() =>
        controlPanel.evaluate(() => JSON.parse(localStorage.getItem("readAloudPlaybackHotkeys")!))
      )
      .toEqual({ toggle: "Ctrl+Alt+Space", back: "F9", forward: "F10" });
  });
});

test("locked and missing-model states", async ({ controlPanel }) => {
  fs.mkdirSync(evidence, { recursive: true });
  await controlPanel.getByRole("button", { name: "Beta features", exact: true }).click();
  await controlPanel.getByRole("button", { name: /^Read Aloud/ }).click();
  await expect(
    controlPanel.getByRole("heading", { name: "Hear it instead of reading" })
  ).toBeVisible();
  await controlPanel.screenshot({ path: path.join(evidence, "after-locked.png") });
  await unlockTesterAccess(controlPanel);
  await controlPanel.getByRole("button", { name: /^Read Aloud( Beta)?$/ }).click();
  const pause = controlPanel.getByRole("button", { name: "Pause or resume hotkey" });
  await expect(pause).toBeDisabled();
  await pause.scrollIntoViewIfNeeded();
  await controlPanel.screenshot({ path: path.join(evidence, "after-model-missing.png") });
});
