import { describe, expect, test } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { readAloudNoticeReason } = require("../../../src/helpers/ipcHandlers");

/**
 * Ledger gate `readaloud-empty-selection-feedback`.
 *
 * A read hotkey that captured nothing used to send the overlay nothing, so an
 * empty selection looked exactly like a shortcut that never fired. The notice
 * event fixes that, and this covers the one decision it makes: which of the two
 * things the overlay is allowed to say.
 *
 * The distinction matters because the wrong one is a lie. "Cannot read
 * selections here" told to a Windows user whose selection was simply empty
 * sends them off debugging a feature that works.
 */
describe("readAloudNoticeReason", () => {
  test("only an unsupported capture is reported as unsupported", () => {
    expect(readAloudNoticeReason("unsupported")).toBe("unsupported");
  });

  test("an empty capture is reported as an empty selection", () => {
    expect(readAloudNoticeReason("none")).toBe("empty-selection");
  });

  test("anything unrecognised falls back to the empty selection wording", () => {
    // A future source, or a malformed result, must not claim the platform
    // cannot do this at all.
    expect(readAloudNoticeReason("selection")).toBe("empty-selection");
    expect(readAloudNoticeReason("clipboard")).toBe("empty-selection");
    expect(readAloudNoticeReason(undefined)).toBe("empty-selection");
    expect(readAloudNoticeReason("")).toBe("empty-selection");
  });
});
