import { expect, test } from "./fixtures/electron-app";

/**
 * Guards the three things that made opening the app look unfinished:
 *
 *  1. The control panel was created with no backgroundColor, so Electron used
 *     its white default and the window's first frames were a white rectangle.
 *  2. index.html pulled two render-blocking stylesheets from api.fontshare.com
 *     and fonts.googleapis.com, so nothing painted until two public servers
 *     answered — worst right after login, when the app auto-starts and the
 *     network is still coming up.
 *  3. The window was revealed on `ready-to-show`, which fires at the first
 *     composited frame — an empty <div id="root"> while the bundle parses.
 *
 * Each of these is invisible to a passing render test, so they get their own
 * assertions rather than relying on a screenshot to notice a regression.
 */

test.describe("app open", () => {
  test("control panel window is created on the product background, not white", async ({
    electronApp,
    controlPanel,
  }) => {
    await controlPanel.waitForLoadState("domcontentloaded");

    const backgroundColor = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) =>
        /panel=true|control/.test(w.webContents.getURL())
      );
      return win ? win.getBackgroundColor() : null;
    });

    // Electron normalises to #RRGGBB. Anything white here means the pre-paint
    // frames are white again.
    expect(backgroundColor?.toLowerCase()).toBe("#080908");
  });

  test("the dictation overlay stays fully transparent", async ({ overlayWindow }) => {
    await overlayWindow.waitForLoadState("load");

    // The control panel needed an opaque pre-paint colour; the overlay must not
    // inherit one, or its first frames are a 400x500 box floating on the desktop.
    // BrowserWindow.getBackgroundColor() drops the alpha channel and reports
    // "#000000" either way, so it cannot tell transparent from opaque black —
    // assert the rendered surface instead. The declared window colour is covered
    // in tests/unit/helpers/windowConfig.test.js.
    const transparency = await overlayWindow.evaluate(() => ({
      html: getComputedStyle(document.documentElement).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
      root: getComputedStyle(document.getElementById("root")!).backgroundColor,
    }));

    expect(transparency.html).toBe("rgba(0, 0, 0, 0)");
    expect(transparency.body).toBe("rgba(0, 0, 0, 0)");
    expect(transparency.root).toBe("rgba(0, 0, 0, 0)");
  });

  test("body background matches the window background so the handover is seamless", async ({
    controlPanel,
  }) => {
    await controlPanel.waitForLoadState("domcontentloaded");

    const bodyBackground = await controlPanel.evaluate(
      () => getComputedStyle(document.body).backgroundColor
    );

    // #080908
    expect(bodyBackground).toBe("rgb(8, 9, 8)");
  });

  test("renders its own fonts with no network fetch", async ({ controlPanel }) => {
    await controlPanel.waitForLoadState("load");

    const fonts = await controlPanel.evaluate(async () => {
      await document.fonts.ready;
      const resources = performance.getEntriesByType(
        "resource"
      ) as PerformanceResourceTiming[];
      return {
        remote: resources
          .map((r) => r.name)
          .filter((name) => /^https?:\/\//.test(name) && !name.startsWith("http://localhost")),
        renderBlocking: resources
          .filter((r) => r.renderBlockingStatus === "blocking")
          .map((r) => r.name),
        satoshiLoaded: document.fonts.check('16px "Satoshi"'),
        bodyFont: getComputedStyle(document.body).fontFamily,
      };
    });

    // The specific hosts that used to gate first paint.
    expect(fonts.remote.filter((n) => /fontshare|googleapis|gstatic/.test(n))).toEqual([]);
    // Nothing render-blocking may live off-machine.
    expect(fonts.renderBlocking.filter((n) => /^https?:\/\//.test(n))).toEqual([]);
    expect(fonts.satoshiLoaded).toBe(true);
    expect(fonts.bodyFont).toContain("Satoshi");
  });

  test("the renderer reports its first real paint, which is what reveals the window", async ({
    controlPanel,
  }) => {
    await controlPanel.waitForLoadState("domcontentloaded");

    // The preload must expose the channel the main process waits on. Without it
    // every window falls back to the timeout and opens a beat late.
    const hasPaintSignal = await controlPanel.evaluate(
      () => typeof window.electronAPI?.notifyRendererPainted === "function"
    );
    expect(hasPaintSignal).toBe(true);

    // And the window that is on screen must have real content on it, not an
    // empty root.
    await expect(controlPanel.locator("#root")).not.toBeEmpty();
  });
});
