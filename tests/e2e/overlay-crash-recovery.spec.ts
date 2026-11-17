import path from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";

/**
 * A crash of the dictation overlay's page process left the window standing
 * with nothing in it, so the hotkey did nothing until the app was restarted.
 * The overlay now reloads itself. This sends the overlay the event Electron
 * raises when its page process dies, then starts a recording through the same
 * IPC message the hotkey sends.
 *
 * A real crash (webContents.forcefullyCrashRenderer) works in the app, but it
 * trips an internal assert in Playwright's own page tracking most runs, so the
 * spec fails for a reason that is not the app's.
 */

const WAV = path.resolve(__dirname, "..", "fixtures", "dictation", "banana.wav");
test.use({ fakeAudioCaptureFile: WAV });

const HALO = 'div[aria-hidden="true"][style*="width: 68px"][style*="radial-gradient"]';

async function inOverlay<T>(app: ElectronApplication, script: string): Promise<T> {
  return app.evaluate(async ({ BrowserWindow }, js) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && !w.webContents.getURL().includes("panel=true")
    );
    if (!win) throw new Error("no dictation overlay window");
    if (win.webContents.isCrashed()) return null;
    return win.webContents.executeJavaScript(js);
  }, script) as Promise<T>;
}

async function sendToOverlay(app: ElectronApplication, channel: string) {
  await app.evaluate(({ BrowserWindow }, ch) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && !w.webContents.getURL().includes("panel=true")
    );
    if (!win) throw new Error("no dictation overlay window");
    win.webContents.send(ch);
  }, channel);
}

test("the overlay reloads after its page crashes, and dictation starts again", async ({
  electronApp,
  overlayWindow,
}) => {
  test.setTimeout(120_000);
  expect(overlayWindow).toBeTruthy();

  // Mark the live page, so a reload is visible as the mark being gone.
  await inOverlay(electronApp, "window.__beforeCrash = true; true");

  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && !w.webContents.getURL().includes("panel=true")
    );
    win!.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: -1 });
  });

  await expect
    .poll(
      () =>
        inOverlay<string | null>(
          electronApp,
          "`${document.readyState}:${Boolean(window.__beforeCrash)}:${Boolean(window.electronAPI)}`"
        ).catch(() => null),
      { timeout: 30_000, intervals: [250] }
    )
    .toBe("complete:false:true");

  // Nothing a run records may reach the clipboard or whatever window has focus.
  await inOverlay(
    electronApp,
    `localStorage.setItem("autoPaste", "false");
     localStorage.setItem("copyToClipboard", "false");
     localStorage.setItem("useReasoningModel", "false");
     true`
  );

  // The page answers the hotkey's message again.
  await sendToOverlay(electronApp, "toggle-dictation");
  await expect
    .poll(() => inOverlay<number>(electronApp, `document.querySelectorAll('${HALO}').length`), {
      timeout: 30_000,
      intervals: [250],
    })
    .toBe(1);
  await sendToOverlay(electronApp, "toggle-dictation");
  await expect
    .poll(() => inOverlay<number>(electronApp, `document.querySelectorAll('${HALO}').length`), {
      timeout: 60_000,
      intervals: [250],
    })
    .toBe(0);
});
