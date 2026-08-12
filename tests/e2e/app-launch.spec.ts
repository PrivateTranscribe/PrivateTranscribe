import path from "node:path";
import { expect, test } from "./fixtures/electron-app";

test.describe("app launch", () => {
  test("opens the dictation overlay and the control panel", async ({
    electronApp,
    overlayWindow,
    controlPanel,
  }) => {
    // Both windows come from the same bundle; the query string is what routes
    // the renderer to the control panel instead of the overlay.
    expect(overlayWindow.url()).not.toContain("panel=true");
    expect(controlPanel.url()).toContain("panel=true");

    const appInfo = await electronApp.evaluate(({ app, BrowserWindow }) => ({
      name: app.getName(),
      version: app.getVersion(),
      windowCount: BrowserWindow.getAllWindows().length,
    }));

    expect(appInfo.name).toBe("PrivateTranscribe");
    expect(appInfo.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(appInfo.windowCount).toBeGreaterThanOrEqual(2);
  });

  test("runs against an isolated user data directory", async ({ electronApp, userDataDir }) => {
    const userData = await electronApp.evaluate(({ app }) => app.getPath("userData"));

    // Guards the fixture's isolation contract: a spec must never read or write
    // the developer's real settings, history database, or API keys.
    expect(path.resolve(userData)).toBe(path.resolve(userDataDir));
  });

  test("keeps its windows off screen and unfocused", async ({ electronApp }) => {
    // A run opens the always-on-top overlay and the control panel once per
    // spec. If the fixture ever stops neutralising them, a suite run takes over
    // the machine — this is the guard against that regressing silently.
    const windows = await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((win) => ({
        opacity: win.getOpacity(),
        focused: win.isFocused(),
        alwaysOnTop: win.isAlwaysOnTop(),
      }))
    );

    expect(windows.length).toBeGreaterThan(0);
    for (const win of windows) {
      expect(win.focused).toBe(false);
      expect(win.alwaysOnTop).toBe(false);
      // getOpacity() is not implemented on Linux and always reports 1 there.
      if (process.platform !== "linux") {
        expect(win.opacity).toBe(0);
      }
    }
  });

  test("boots the renderer without uncaught exceptions", async ({
    controlPanel,
    overlayWindow,
    consoleMessages,
  }) => {
    await expect(controlPanel.locator("#root")).not.toBeEmpty();
    await expect(overlayWindow.locator("#root")).not.toBeEmpty();

    // Console warnings are expected noise; an uncaught renderer exception is not.
    const pageErrors = consoleMessages.filter((message) => message.type === "pageerror");
    expect(pageErrors, `Renderer threw: ${pageErrors.map((e) => e.text).join(" | ")}`).toEqual([]);
  });
});
