import path from "node:path";
import { expect, test } from "./fixtures/electron-app";

/**
 * The microphone picker promises that dictation falls back to the system
 * default while the picked microphone is unplugged. Recording used to ask for
 * the picked device by its exact id anyway, and Chromium refused it, so the
 * dictation stopped with "Failed to access microphone".
 *
 * The fake capture device is the only input here, so a saved pick naming any
 * other device is exactly an unplugged microphone.
 */
test.use({
  fakeAudioCaptureFile: path.resolve("tests/fixtures/dictation/banana.wav"),
});

test("dictation records from the default microphone while the picked one is unplugged", async ({
  electronApp,
  overlayWindow,
  consoleMessages,
}) => {
  await overlayWindow.evaluate(() => {
    localStorage.setItem("autoPaste", "false");
    localStorage.setItem("copyToClipboard", "false");
    localStorage.setItem("audioFeedback", "false");
    localStorage.setItem("useReasoningModel", "false");
    localStorage.setItem("preferBuiltInMic", "false");
    localStorage.setItem("selectedMicDeviceId", "unplugged-usb-microphone");
  });
  await overlayWindow.reload();
  await expect(overlayWindow.getByRole("button", { name: "Dictation overlay" })).toBeVisible();

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((win) => !win.webContents.getURL().includes("panel=true"))!
      .webContents.send("start-dictation");
  });

  // The level bars only appear once a microphone stream is recording.
  await expect(overlayWindow.locator('div[style*="scaleY("]')).toHaveCount(5);
  expect(
    consoleMessages.filter((message) => message.text.includes("Failed to access microphone"))
  ).toEqual([]);
});
