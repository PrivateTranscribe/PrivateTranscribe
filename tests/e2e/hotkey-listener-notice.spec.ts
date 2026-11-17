import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
import { evidenceDir } from "./fixtures/evidence";

/**
 * When the hotkey listener on Windows crashed, the main process sent
 * "windows-ptt-unavailable" and nothing listened, so Hold and Both modes just
 * stopped. The listener now restarts itself twice (unit-tested on real child
 * processes in tests/unit/helpers/windowsKeyManager.test.ts) and main sends
 * this message when that did not help. This sends the message main sends and
 * checks the overlay shows the notice.
 *
 * The real listener is not killed here: in a test run it would first watch
 * Ctrl+Space, the developer's own dictation key, on the real desktop.
 */

test("the overlay tells the user when the hotkey listener stops for good", async ({
  electronApp,
  overlayWindow,
}) => {
  const shots = evidenceDir("hotkey-listener-notice");
  fs.mkdirSync(shots, { recursive: true });

  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && !w.webContents.getURL().includes("panel=true")
    );
    win!.webContents.send("windows-ptt-unavailable", {
      reason: "error",
      kind: "crashed",
      message: "Windows key listener exited with code 3221225477 signal null",
    });
  });

  await expect(overlayWindow.getByText("Hotkey listener stopped")).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    overlayWindow.getByText("Restart PrivateTranscribe to get your hotkey back", { exact: false })
  ).toBeVisible();
  await overlayWindow.screenshot({ path: path.join(shots, "overlay-notice.png") });
});

test("a developer build without the listener binary gets no notice", async ({
  electronApp,
  overlayWindow,
}) => {
  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && !w.webContents.getURL().includes("panel=true")
    );
    win!.webContents.send("windows-ptt-unavailable", {
      reason: "binary_not_found",
      message: "Push-to-Talk native listener not available",
    });
  });
  await overlayWindow.waitForTimeout(1500);
  await expect(overlayWindow.getByText("Hotkey listener stopped")).toHaveCount(0);
  await expect(overlayWindow.getByText("Hotkey not supported")).toHaveCount(0);
});
