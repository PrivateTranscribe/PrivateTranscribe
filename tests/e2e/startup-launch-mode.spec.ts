import { expect, test } from "./fixtures/electron-app";

// A Windows login launch passes `--launch-at-login --startup-mode=<mode>` from the
// Run key. The mode is about the control panel only. The dictation overlay has to
// show up on every launch, or the user boots into a PC with no floating button
// until the first hotkey press.
type WindowState = {
  url: string;
  visible: boolean;
  minimized: boolean;
};

async function readWindows(
  electronApp: Parameters<Parameters<typeof test>[2]>[0]["electronApp"]
): Promise<WindowState[]> {
  return electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((win) => ({
      url: win.webContents.getURL(),
      visible: win.isVisible(),
      minimized: win.isMinimized(),
    }))
  );
}

function overlayOf(windows: WindowState[]) {
  return windows.find((w) => !w.url.includes("panel=true"));
}

function panelOf(windows: WindowState[]) {
  return windows.find((w) => w.url.includes("panel=true"));
}

test.describe("login launch, tray mode", () => {
  test.use({ appArgs: ["--launch-at-login", "--startup-mode=tray"] });

  test("shows the overlay and keeps the control panel hidden", async ({
    electronApp,
    overlayWindow,
  }) => {
    await expect(overlayWindow.locator("#root")).not.toBeEmpty();
    // The overlay reveals itself on its own renderer-ready signal, so poll.
    await expect
      .poll(async () => overlayOf(await readWindows(electronApp))?.visible, { timeout: 15_000 })
      .toBe(true);

    const panel = panelOf(await readWindows(electronApp));
    expect(panel).toBeDefined();
    expect(panel?.visible).toBe(false);
  });
});

test.describe("login launch, minimized mode", () => {
  test.use({ appArgs: ["--launch-at-login", "--startup-mode=minimized"] });

  test("shows the overlay alongside the control panel", async ({ electronApp, overlayWindow }) => {
    await expect(overlayWindow.locator("#root")).not.toBeEmpty();
    await expect
      .poll(async () => overlayOf(await readWindows(electronApp))?.visible, { timeout: 15_000 })
      .toBe(true);

    // The fixture forces every window to skip the taskbar and re-shows it
    // inactive, so "minimized to the taskbar" is not observable here. The
    // panel existing is all this mode can prove under the harness.
    expect(panelOf(await readWindows(electronApp))).toBeDefined();
  });
});
