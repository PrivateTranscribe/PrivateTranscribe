import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  isScreenPointInOverlayRegions,
  normalizeOverlayInteractiveRegions,
} = require("../../../src/helpers/overlayHitTest");

describe("overlay interactive-region hit testing", () => {
  test("keeps valid regions inside the transparent window bounds", () => {
    expect(
      normalizeOverlayInteractiveRegions(
        [
          { x: -10, y: 20, width: 40, height: 30 },
          { x: 390, y: 490, width: 30, height: 30 },
          { x: 10, y: 10, width: 0, height: 20 },
          { x: Number.NaN, y: 0, width: 10, height: 10 },
        ],
        { width: 400, height: 500 }
      )
    ).toEqual([
      { x: 0, y: 20, width: 30, height: 30 },
      { x: 390, y: 490, width: 10, height: 10 },
    ]);
  });

  test("captures only points inside reported visible regions", () => {
    const bounds = { x: 1000, y: 400, width: 400, height: 500 };
    const groups = [
      [{ x: 40, y: 50, width: 320, height: 80 }],
      [{ x: 75, y: 150, width: 250, height: 300 }],
    ];

    expect(isScreenPointInOverlayRegions({ x: 1050, y: 460 }, bounds, groups)).toBe(true);
    expect(isScreenPointInOverlayRegions({ x: 1200, y: 700 }, bounds, groups)).toBe(true);
    expect(isScreenPointInOverlayRegions({ x: 1010, y: 890 }, bounds, groups)).toBe(false);
  });

  test("wires toast/menu regions without using toast count as a full-window lock", () => {
    const app = fs.readFileSync(path.resolve("src/App.jsx"), "utf8");
    const toast = fs.readFileSync(path.resolve("src/components/ui/Toast.tsx"), "utf8");
    const windowManager = fs.readFileSync(path.resolve("src/helpers/windowManager.js"), "utf8");

    expect(app).not.toContain("toastCount");
    expect(app).toContain('setMainWindowInteractiveRegions?.("overlay-menu"');
    expect(toast).toContain('setMainWindowInteractiveRegions?.("overlay-toasts"');
    expect(windowManager).toContain("this._isCursorOverOverlayInteractiveRegion()");

    const createWindowStart = windowManager.indexOf("async createMainWindow");
    const browserWindowCreated = windowManager.indexOf("new BrowserWindow", createWindowStart);
    const createWindowSetup = windowManager.slice(createWindowStart, browserWindowCreated);
    expect(createWindowSetup).toContain("this._overlayMouseCaptured = null");
  });
});
