import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
import { unlockTesterAccess } from "./fixtures/tester-access";

const evidence = path.resolve(process.env.PT_READALOUD_EVIDENCE_DIR || "docs/qa-readaloud-layout");
test.use({ useThrowawayHome: true, seedKokoroModel: true });

test("Read Aloud layout", async ({ controlPanel }) => {
  fs.mkdirSync(evidence, { recursive: true });
  await unlockTesterAccess(controlPanel);
  await controlPanel.getByRole("button", { name: /^Read Aloud( Beta)?$/ }).click();
  await expect(
    controlPanel.getByRole("button", { name: "Read Aloud hotkey", exact: true })
  ).toBeEnabled();
  const shortcuts = controlPanel.getByTestId("readaloud-shortcuts");
  const fields = shortcuts.getByRole("button");
  await expect(fields).toHaveCount(4);
  const rects = await fields.evaluateAll((elements) =>
    elements.map((element) => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })
  );
  expect(new Set(rects.map((r) => r.x)).size).toBe(1);
  expect(new Set(rects.map((r) => r.width)).size).toBe(1);
  expect(new Set(rects.map((r) => r.height)).size).toBe(1);
  await expect(controlPanel.getByTestId("readaloud-voice-list")).toHaveCount(0);
  await controlPanel.screenshot({
    animations: "disabled",
    path: path.join(evidence, "after-page.png"),
  });
  await shortcuts.screenshot({
    animations: "disabled",
    path: path.join(evidence, "after-shortcuts.png"),
  });
  const pause = controlPanel.getByRole("button", { name: "Pause or resume hotkey" });
  await pause.click();
  await expect(pause).toContainText("Recording");
  expect((await pause.boundingBox())?.height).toBe(rects[1].height);
  await shortcuts.screenshot({
    animations: "disabled",
    path: path.join(evidence, "after-recording.png"),
  });
  await pause.click({ button: "middle" });
  await expect(controlPanel.getByTestId("hotkey-conflict")).toContainText("Use a keyboard key");
  await shortcuts.screenshot({
    animations: "disabled",
    path: path.join(evidence, "after-invalid-key.png"),
  });
  await controlPanel.keyboard.press("Control+Alt+R");
  await expect(controlPanel.getByTestId("hotkey-conflict")).toContainText(
    "Already used by Read Aloud"
  );
  expect((await pause.boundingBox())?.height).toBe(rects[1].height);
  await shortcuts.screenshot({
    animations: "disabled",
    path: path.join(evidence, "after-conflict.png"),
  });
  await controlPanel.keyboard.press("F8");
  await expect(pause).toContainText("F8");
  await shortcuts.screenshot({
    animations: "disabled",
    path: path.join(evidence, "after-custom.png"),
  });
  await pause.click();
  await controlPanel.keyboard.press("Control+Alt+Shift+F10");
  await expect(pause).toContainText("F10");
  await shortcuts.screenshot({
    animations: "disabled",
    path: path.join(evidence, "after-long-shortcut.png"),
  });
  await pause.click();
  await controlPanel.keyboard.press("Backspace");
  await expect(pause).toContainText("Space");
  await controlPanel.getByRole("button", { name: "Change voice", exact: true }).click();
  await expect(controlPanel.getByTestId("readaloud-voice-list")).toBeVisible();
  await controlPanel
    .getByTestId("readaloud-voice-picker")
    .screenshot({ animations: "disabled", path: path.join(evidence, "after-voices-open.png") });
  await controlPanel.getByRole("button", { name: "Done", exact: true }).click();
  await expect(controlPanel.getByTestId("readaloud-voice-list")).toHaveCount(0);
  await controlPanel.setViewportSize({ width: 1000, height: 800 });
  await shortcuts.scrollIntoViewIfNeeded();
  const narrow = await fields.evaluateAll((elements) =>
    elements.map((element) => {
      const r = element.getBoundingClientRect();
      return { x: r.x, right: r.right, width: r.width };
    })
  );
  expect(new Set(narrow.map((r) => r.x)).size).toBe(1);
  expect(narrow.every((r) => r.right <= 1000)).toBe(true);
  await controlPanel.screenshot({
    animations: "disabled",
    path: path.join(evidence, "after-narrow.png"),
  });
});

test.describe("without a voice model", () => {
  test.use({ seedKokoroModel: false });
  test("locked and missing-model layouts", async ({ controlPanel }) => {
    fs.mkdirSync(evidence, { recursive: true });
    await controlPanel.getByRole("button", { name: "Beta features", exact: true }).click();
    await controlPanel.getByRole("button", { name: /^Read Aloud/ }).click();
    await expect(
      controlPanel.getByRole("heading", { name: "Hear it instead of reading" })
    ).toBeVisible();
    await controlPanel.screenshot({
      animations: "disabled",
      path: path.join(evidence, "after-locked.png"),
    });
    await unlockTesterAccess(controlPanel);
    await controlPanel.getByRole("button", { name: /^Read Aloud( Beta)?$/ }).click();
    await expect(controlPanel.getByRole("button", { name: /Download voice model/ })).toBeEnabled();
    const fields = controlPanel.getByTestId("readaloud-shortcuts").getByRole("button");
    for (const field of await fields.all()) await expect(field).toBeDisabled();
    await controlPanel.screenshot({
      animations: "disabled",
      path: path.join(evidence, "after-model-missing.png"),
    });
  });
});
