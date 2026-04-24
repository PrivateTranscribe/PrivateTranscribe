/**
 * Tests for context menu positioning logic in the overlay.
 *
 * The overlay is a fixed CONTAINER_W×CONTAINER_H (400×500) transparent Electron window.
 * The button sits near the bottom of the container (rect.top ≈ 398, rect.bottom ≈ 442).
 *
 * We extract the pure positioning function so it can be unit-tested without a DOM.
 */

const CONTAINER_W = 400;
const CONTAINER_H = 500;
const MENU_EST_HEIGHT = 320;
const MENU_WIDTH = 248;
const EDGE = 8;
const GAP = 12;

type MenuStyle =
  | { position: "absolute"; left: number; bottom: number; pointerEvents: "auto" }
  | { position: "absolute"; left: number; top: number; pointerEvents: "auto" };

/**
 * Pure reimplementation of the menuStyle IIFE from App.jsx for unit testing.
 */
function computeMenuStyle(
  rect: { left: number; right: number; top: number; bottom: number; width: number; height: number },
  iW: number,
  iH: number,
): MenuStyle {
  const desiredLeft = rect.left + rect.width / 2 - MENU_WIDTH / 2;
  const menuLeft = Math.max(EDGE, Math.min(iW - MENU_WIDTH - EDGE, desiredLeft));

  const spaceAbove = rect.top - EDGE;
  const spaceBelow = iH - (rect.bottom + EDGE);

  if (spaceAbove >= MENU_EST_HEIGHT || spaceAbove >= spaceBelow) {
    // Open upward: bottom <= iH - MENU_EST_HEIGHT - EDGE prevents overflowing top
    const menuBottom = iH - rect.top + GAP;
    const clampedBottom = Math.min(iH - MENU_EST_HEIGHT - EDGE, Math.max(EDGE, menuBottom));
    return { position: "absolute", left: menuLeft, bottom: clampedBottom, pointerEvents: "auto" };
  } else {
    const menuTop = rect.bottom + GAP;
    const clampedTop = Math.max(EDGE, Math.min(iH - MENU_EST_HEIGHT - EDGE, menuTop));
    return { position: "absolute", left: menuLeft, top: clampedTop, pointerEvents: "auto" };
  }
}

/** Button rect when overlay is at default position (bottom of screen) */
const BUTTON_DEFAULT: DOMRect = {
  left: 176,
  right: 224,
  top: 398,
  bottom: 442,
  width: 48,
  height: 44,
  x: 176,
  y: 398,
  toJSON: () => ({}),
};

/** Button rect when overlay is near the top of the screen (simulated) */
const BUTTON_TOP: DOMRect = {
  left: 176,
  right: 224,
  top: 398,  // same relative position inside the 400×500 window
  bottom: 442,
  width: 48,
  height: 44,
  x: 176,
  y: 398,
  toJSON: () => ({}),
};

describe("computeMenuStyle — overlay context menu positioning", () => {
  describe("default overlay position (ample space above button)", () => {
    const style = computeMenuStyle(BUTTON_DEFAULT, CONTAINER_W, CONTAINER_H);

    it("opens upward (uses bottom, not top)", () => {
      expect("bottom" in style).toBe(true);
      expect("top" in style).toBe(false);
    });

    it("left is horizontally centered and within container bounds", () => {
      expect(style.left).toBeGreaterThanOrEqual(EDGE);
      expect(style.left + MENU_WIDTH).toBeLessThanOrEqual(CONTAINER_W - EDGE);
    });

    it("menu top edge (computed) stays within container", () => {
      if ("bottom" in style) {
        const menuTopFromBottom = CONTAINER_H - style.bottom - MENU_EST_HEIGHT;
        expect(menuTopFromBottom).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("button near top of window (spaceAbove < MENU_EST_HEIGHT)", () => {
    // Simulate button at top — e.g. rect.top = 50
    const buttonNearTop: DOMRect = {
      ...BUTTON_DEFAULT,
      top: 50,
      bottom: 94,
    };
    const style = computeMenuStyle(buttonNearTop, CONTAINER_W, CONTAINER_H);

    it("opens downward (uses top, not bottom)", () => {
      expect("top" in style).toBe(true);
      expect("bottom" in style).toBe(false);
    });

    it("top is below the button with a gap", () => {
      if ("top" in style) {
        expect(style.top).toBeGreaterThanOrEqual(buttonNearTop.bottom + GAP - 1);
      }
    });

    it("menu bottom edge stays within container", () => {
      if ("top" in style) {
        expect(style.top + MENU_EST_HEIGHT).toBeLessThanOrEqual(CONTAINER_H);
      }
    });
  });

  describe("button in middle of window (equal space above and below)", () => {
    const buttonMiddle: DOMRect = {
      ...BUTTON_DEFAULT,
      top: 228,
      bottom: 272,
    };
    const style = computeMenuStyle(buttonMiddle, CONTAINER_W, CONTAINER_H);

    it("opens in a direction that keeps menu within container", () => {
      if ("bottom" in style) {
        const estimatedMenuTop = CONTAINER_H - style.bottom - MENU_EST_HEIGHT;
        expect(estimatedMenuTop).toBeGreaterThanOrEqual(-EDGE);
      } else if ("top" in style) {
        expect(style.top + MENU_EST_HEIGHT).toBeLessThanOrEqual(CONTAINER_H + EDGE);
      }
    });
  });

  describe("button near left edge", () => {
    const buttonLeft: DOMRect = { ...BUTTON_DEFAULT, left: 5, right: 53, width: 48 };
    const style = computeMenuStyle(buttonLeft, CONTAINER_W, CONTAINER_H);

    it("clamps left to minimum edge", () => {
      expect(style.left).toBeGreaterThanOrEqual(EDGE);
    });
  });

  describe("button near right edge", () => {
    const buttonRight: DOMRect = { ...BUTTON_DEFAULT, left: 360, right: 392, width: 32 };
    const style = computeMenuStyle(buttonRight, CONTAINER_W, CONTAINER_H);

    it("clamps so menu does not overflow right edge", () => {
      expect(style.left + MENU_WIDTH).toBeLessThanOrEqual(CONTAINER_W - EDGE);
    });
  });
});
