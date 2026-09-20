import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
import type { Page, TestInfo } from "@playwright/test";

const capture = (page: Page, info: TestInfo, name: string) =>
  page.screenshot({
    path: process.env.READ_ALOUD_EVIDENCE_DIR
      ? path.join(process.env.READ_ALOUD_EVIDENCE_DIR, name)
      : info.outputPath(name),
  });

test.describe("installed voice model", () => {
  test.use({ seedKokoroModel: true });
  test("reading speed is saved and reaches speech synthesis", async ({
    controlPanel,
    overlayWindow,
  }, info) => {
    test.setTimeout(120_000);
    await controlPanel.getByRole("button", { name: /^Read Aloud( Beta)?$/ }).click();
    await expect(controlPanel.getByTestId("readaloud-voice-picker")).toBeVisible();
    const speed = controlPanel.getByRole("combobox", { name: "Reading speed" });
    await expect(speed).toHaveText("1× (Normal)");
    await capture(controlPanel, info, "read-speed-after-normal.png");
    await overlayWindow.waitForFunction(() => Boolean((window as any).__readAloudTest));
    const measureRead = async (expectedSpeed: number) => {
      await expect
        .poll(() => overlayWindow.evaluate(() => localStorage.getItem("readAloudSpeed")))
        .toBe(String(expectedSpeed));
      await overlayWindow.evaluate(() => {
        void (window as any).__readAloudTest.speak("Testing the reading speed.");
      });
      await expect
        .poll(
          () =>
            overlayWindow.evaluate(
              () => (window as any).__readAloudTest.getFirstBufferStats()?.durationSec
            ),
          { timeout: 60_000 }
        )
        .toBeGreaterThan(0);
      return overlayWindow.evaluate(() => {
        const player = (window as any).__readAloudTest;
        const result = {
          speed: player.getState().speed,
          seconds: player.getFirstBufferStats().durationSec,
        };
        player.stop();
        return result;
      });
    };
    const normal = await measureRead(1);
    await speed.click();
    await expect(controlPanel.getByRole("option")).toHaveCount(6);
    await capture(controlPanel, info, "read-speed-after-open.png");
    await controlPanel.getByRole("option", { name: "2×", exact: true }).click();
    const fast = await measureRead(2);
    expect(normal.speed).toBe(1);
    expect(fast.speed).toBe(2);
    expect(fast.seconds).toBeLessThan(normal.seconds * 0.7);
    console.log(
      `Read Aloud duration: 1x=${normal.seconds.toFixed(2)}s, 2x=${fast.seconds.toFixed(2)}s`
    );
    await controlPanel.reload({ waitUntil: "domcontentloaded" });
    await controlPanel.getByRole("button", { name: /^Read Aloud( Beta)?$/ }).click();
    await expect(speed).toHaveText("2×");
    await capture(controlPanel, info, "read-speed-after-selected.png");
    await speed.focus();
    await controlPanel.keyboard.press("Space");
    await controlPanel.keyboard.press("Home");
    await controlPanel.keyboard.press("Enter");
    await expect(speed).toHaveText("0.75×");
    await controlPanel.evaluate(() => localStorage.setItem("readAloudSpeed", "invalid"));
    await controlPanel.reload({ waitUntil: "domcontentloaded" });
    await controlPanel.getByRole("button", { name: /^Read Aloud( Beta)?$/ }).click();
    await expect(speed).toHaveText("1× (Normal)");
  });
});

test.describe("missing voice model", () => {
  test.use({ useThrowawayHome: true });
  test("speed control is disabled until the voice model is installed", async ({
    controlPanel,
  }, info) => {
    await controlPanel.getByRole("button", { name: /^Read Aloud( Beta)?$/ }).click();
    await expect(controlPanel.getByRole("combobox", { name: "Reading speed" })).toBeDisabled();
    await expect(controlPanel.getByRole("button", { name: /Download voice model/ })).toBeEnabled();
    await capture(controlPanel, info, "read-speed-after-missing.png");
  });
});
