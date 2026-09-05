import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { shouldPersistOverlayMove } = require("../../../src/helpers/windowConfig");

/**
 * Windows moves every window off a monitor the moment it drops. That move
 * used to be saved as the user's chosen overlay spot, so when the monitor came
 * back the overlay stayed on the wrong screen until the user dragged it home.
 */
describe("shouldPersistOverlayMove", () => {
  const main = 1;
  const side = 2;

  it("saves a drag, even onto another display", () => {
    expect(
      shouldPersistOverlayMove({ isDragging: true, previousDisplayId: main, nextDisplayId: side })
    ).toEqual({ persist: true, reason: "drag" });
  });

  it("ignores a move to another display that was not a drag", () => {
    expect(
      shouldPersistOverlayMove({ isDragging: false, previousDisplayId: main, nextDisplayId: side })
    ).toEqual({ persist: false, reason: "os-moved-to-other-display" });
  });

  it("ignores any move inside the quiet window a display change opens", () => {
    expect(
      shouldPersistOverlayMove({
        now: 1_000,
        ignoreUntil: 8_000,
        previousDisplayId: main,
        nextDisplayId: main,
      })
    ).toEqual({ persist: false, reason: "display-change-quiet-window" });
  });

  it("saves an ordinary move on the same display", () => {
    expect(
      shouldPersistOverlayMove({
        now: 9_000,
        ignoreUntil: 8_000,
        previousDisplayId: main,
        nextDisplayId: main,
      })
    ).toEqual({ persist: true, reason: "same-display" });
  });

  it("saves when there is no earlier spot to compare with", () => {
    expect(shouldPersistOverlayMove({ previousDisplayId: null, nextDisplayId: side })).toEqual({
      persist: true,
      reason: "same-display",
    });
  });
});
