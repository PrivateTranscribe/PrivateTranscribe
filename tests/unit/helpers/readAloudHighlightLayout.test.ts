import { describe, expect, it } from "vitest";

// The layout maths behind the in-place Read Aloud highlight: UI Automation
// hands back physical screen pixels, a BrowserWindow takes DIPs, and the
// page inside it paints boxes relative to the window. Pure, so it is pinned
// here; the window and the worker are exercised live.
const { layoutHighlight, PAD } = require("../../../src/helpers/readAloudHighlight.js");

type Rect = { x: number; y: number; width: number; height: number };
const identity = (r: Rect) => r;
const halve = (r: Rect) => ({ x: r.x / 2, y: r.y / 2, width: r.width / 2, height: r.height / 2 });

describe("layoutHighlight", () => {
  it("returns null when there is nothing to paint", () => {
    expect(layoutHighlight([], identity)).toBeNull();
    expect(layoutHighlight([{ x: 10, y: 10, w: 0, h: 20 }], identity)).toBeNull();
  });

  it("wraps one rectangle in a padded window and paints it at the pad offset", () => {
    const layout = layoutHighlight([{ x: 100, y: 200, w: 300, h: 24 }], identity);
    expect(layout.bounds).toEqual({
      x: 100 - PAD,
      y: 200 - PAD,
      width: 300 + PAD * 2,
      height: 24 + PAD * 2,
    });
    expect(layout.boxes).toEqual([{ x: PAD, y: PAD, width: 300, height: 24 }]);
  });

  it("spans a sentence that wraps onto two lines with one window and two boxes", () => {
    const layout = layoutHighlight(
      [
        { x: 400, y: 100, w: 500, h: 20 },
        { x: 40, y: 124, w: 120, h: 20 },
      ],
      identity
    );
    expect(layout.bounds).toEqual({
      x: 40 - PAD,
      y: 100 - PAD,
      width: 860 + PAD * 2,
      height: 44 + PAD * 2,
    });
    expect(layout.boxes).toEqual([
      { x: 360 + PAD, y: PAD, width: 500, height: 20 },
      { x: PAD, y: 24 + PAD, width: 120, height: 20 },
    ]);
  });

  it("converts physical pixels to DIPs before laying out (200% scaling)", () => {
    const layout = layoutHighlight([{ x: 1000, y: 600, w: 400, h: 40 }], halve);
    expect(layout.bounds).toEqual({
      x: 500 - PAD,
      y: 300 - PAD,
      width: 200 + PAD * 2,
      height: 20 + PAD * 2,
    });
    expect(layout.boxes).toEqual([{ x: PAD, y: PAD, width: 200, height: 20 }]);
  });

  it("never produces a zero-sized window from fractional DIPs", () => {
    const layout = layoutHighlight([{ x: 3, y: 3, w: 1, h: 1 }], (r) => ({
      x: r.x / 3,
      y: r.y / 3,
      width: r.width / 3,
      height: r.height / 3,
    }));
    expect(layout.bounds.width).toBeGreaterThanOrEqual(1);
    expect(layout.bounds.height).toBeGreaterThanOrEqual(1);
  });
});
