import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
import { evidenceDir } from "./fixtures/evidence";

const phase = process.env.PT_COMPACT_PLAYER_BEFORE === "1" ? "before" : "after";
const evidence = evidenceDir("qa-readaloud-compact");
test.use({ seedKokoroModel: true });

test("compact read aloud controls stay readable and still", async ({
  overlayWindow,
  electronApp,
}) => {
  const bar = overlayWindow.getByTestId("readaloud-overlay-player");
  fs.mkdirSync(evidence, { recursive: true });
  const capture = async (state: string) => {
    await bar.evaluate(async (el) => {
      await Promise.all(
        el
          .getAnimations({ subtree: true })
          .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
          .map((animation) => animation.finished)
      );
    });
    await overlayWindow.screenshot({ path: path.join(evidence, `${phase}-${state}.png`) });
    // Keep a close view too: transparent window margins aren't visible UI.
    await bar.screenshot({ path: path.join(evidence, `${phase}-${state}-detail.png`) });
  };
  await overlayWindow.evaluate(async () => {
    await (window as any).electronAPI.readAloudLoadEngine();
    void (window as any).__readAloudTest.speak(
      "A quiet morning makes room for a little reading. Keep your place as the words are spoken."
    );
  });
  await expect(bar.getByRole("button", { name: "Pause reading" })).toBeVisible();
  await capture("playing");
  const initial = await bar.boundingBox();
  if (phase === "after") {
    expect(initial!.width).toBeLessThanOrEqual(200);
    expect(initial!.height).toBeLessThanOrEqual(36);
  }
  await bar.getByRole("button", { name: "Pause reading" }).click();
  await expect(bar).toContainText("Paused");
  expect(await bar.boundingBox()).toEqual(initial);
  await overlayWindow.mouse.move(0, 0);
  await capture("paused");
  await bar.getByRole("button", { name: "Resume reading" }).focus();
  await overlayWindow.keyboard.press("Tab");
  await overlayWindow.keyboard.press("Shift+Tab");
  expect(
    await bar
      .getByRole("button", { name: "Resume reading" })
      .evaluate((el) => el.matches(":focus-visible"))
  ).toBe(true);
  await capture("keyboard-focus");
  await overlayWindow.keyboard.press("Enter");
  await expect(bar.getByRole("button", { name: "Pause reading" })).toBeVisible();
  await bar.getByRole("button", { name: "Pause reading" }).click();
  await electronApp.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows())
      win.webContents.send("readaloud-control", { op: "forward" });
  });
  await expect(bar.getByTestId("readaloud-progress")).toHaveAttribute("data-position", "2/2");
  expect(await bar.boundingBox()).toEqual(initial);
  await capture("next-sentence");
  await bar.getByRole("button", { name: "Stop reading" }).click();
  await expect(bar).toHaveCount(0);

  await electronApp.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows())
      win.webContents.send("readaloud-speak", {
        text: "Reading from the clipboard keeps the source clear while the controls stay small.",
        source: "clipboard",
      });
  });
  await expect(bar).toContainText("Reading clipboard");
  if (phase === "after") {
    const label = await bar.getByText("Reading clipboard").boundingBox();
    const pause = await bar.getByRole("button", { name: "Pause reading" }).boundingBox();
    expect(label!.x + label!.width).toBeLessThan(pause!.x);
    expect(await bar.boundingBox()).toEqual(initial);
  }
  await capture("clipboard");
  await bar.getByRole("button", { name: "Stop reading" }).click();
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("readaloud-split");
    ipcMain.handle(
      "readaloud-split",
      () =>
        new Promise((_resolve, reject) => {
          (globalThis as any).__rejectReadForDesign = reject;
        })
    );
  });
  await overlayWindow.evaluate(() => {
    void (window as any).__readAloudTest.speak("A test error.");
  });
  await expect(bar).toContainText("Preparing");
  if (phase === "after")
    await expect(bar.getByTestId("readaloud-progress")).not.toHaveAttribute("aria-valuenow");
  await bar.evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((animation) => animation.finished));
  });
  if (phase === "after") expect(await bar.boundingBox()).toEqual(initial);
  await capture("preparing");
  await electronApp.evaluate(() =>
    (globalThis as any).__rejectReadForDesign(new Error("Test unavailable engine"))
  );
  await expect(bar).toContainText("Could not read that");
  if (phase === "after") expect(await bar.boundingBox()).toEqual(initial);
  await capture("error");
  await bar.getByRole("button", { name: "Stop reading" }).click();
  await expect(bar).toHaveCount(0);
});
