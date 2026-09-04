import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MAIN_WINDOW_CONFIG, CONTROL_PANEL_CONFIG } = require("../../../src/helpers/windowConfig");

/**
 * Electron paints a window's `backgroundColor` for every frame before the
 * renderer has anything on screen. Unset, that colour is white — which is what
 * made the control panel open as a white 1200x800 rectangle while the bundle
 * was still parsing.
 *
 * BrowserWindow.getBackgroundColor() drops the alpha channel, so a running app
 * cannot tell "transparent" from "opaque black". The declared values are the
 * only place this can actually be asserted.
 */
describe("window pre-paint background", () => {
  it("opens the control panel on the product background, never white", () => {
    // Must equal --color-background in index.css, or the handover from the
    // window colour to the page flashes.
    expect(CONTROL_PANEL_CONFIG.backgroundColor).toBe("#080908");
  });

  it("keeps the dictation overlay fully transparent", () => {
    expect(MAIN_WINDOW_CONFIG.transparent).toBe(true);
    // 8 digits: the last pair is alpha. An opaque colour here would put a solid
    // 400x500 box on the desktop until the renderer paints.
    expect(MAIN_WINDOW_CONFIG.backgroundColor).toBe("#00000000");
  });

  it("never throttles the dictation overlay when it is not in front", () => {
    // Chromium stops requestAnimationFrame in a window it considers hidden,
    // which an occluded always-on-top overlay is. The level meter runs on
    // requestAnimationFrame, so the default would freeze the bars for exactly
    // the case the overlay exists to cover.
    expect(MAIN_WINDOW_CONFIG.webPreferences.backgroundThrottling).toBe(false);
  });

  it("keeps both windows hidden until something asks for them", () => {
    expect(MAIN_WINDOW_CONFIG.show).toBe(false);
    expect(CONTROL_PANEL_CONFIG.show).toBe(false);
  });
});
