import { describe, expect, test } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  BUTTON_HALF,
  BUTTON_OFFSET_X,
  BUTTON_OFFSET_Y,
  CONTAINER_H,
  CONTAINER_W,
  TASKBAR_SNAP_GAP,
  WindowPositionUtil,
} = require("../../../src/helpers/windowConfig.js");

describe("WindowPositionUtil taskbar snap positioning", () => {
  test("bottom taskbar snap keeps the overlay button just inside the usable work area", () => {
    const display = {
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      workArea: { x: 0, y: 0, width: 800, height: 552 },
    };

    const pos = WindowPositionUtil.getTaskbarSnappedPosition(
      120,
      100,
      CONTAINER_W,
      CONTAINER_H,
      display
    );

    const workAreaBottom = display.workArea.y + display.workArea.height;
    const buttonBottom = pos.y + BUTTON_OFFSET_Y + BUTTON_HALF;
    expect(buttonBottom).toBe(workAreaBottom - TASKBAR_SNAP_GAP);
  });

  test("left taskbar snap keeps the overlay button just inside the usable work area", () => {
    const display = {
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      workArea: { x: 48, y: 0, width: 752, height: 600 },
    };

    const pos = WindowPositionUtil.getTaskbarSnappedPosition(
      200,
      100,
      CONTAINER_W,
      CONTAINER_H,
      display
    );

    const buttonLeft = pos.x + BUTTON_OFFSET_X - BUTTON_HALF;
    expect(buttonLeft).toBe(display.workArea.x + TASKBAR_SNAP_GAP);
  });

  test("auto-hidden taskbar fallback keeps the overlay button above the screen edge", () => {
    const display = {
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      workArea: { x: 0, y: 0, width: 800, height: 600 },
    };

    const pos = WindowPositionUtil.getTaskbarSnappedPosition(
      120,
      100,
      CONTAINER_W,
      CONTAINER_H,
      display
    );

    const buttonBottom = pos.y + BUTTON_OFFSET_Y + BUTTON_HALF;
    expect(buttonBottom).toBe(display.workArea.y + display.workArea.height - TASKBAR_SNAP_GAP);
  });
});
