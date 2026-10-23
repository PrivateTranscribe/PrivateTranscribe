import { describe, expect, it } from "vitest";

const { parseSavedHistoryLimit } = require("../../../src/helpers/ipcHandlers");

// The main process saves the history limit so a window that lost its own
// settings takes it instead of trimming history to the default 50.
describe("parseSavedHistoryLimit", () => {
  it.each([
    ["500", 500],
    ["0", 0],
    ["250000", 100_000],
  ])("reads %j as %j", (raw, limit) => {
    expect(parseSavedHistoryLimit(raw)).toBe(limit);
  });

  it.each([undefined, null, "", "  ", "-5", "lots"])("treats %j as never saved", (raw) => {
    expect(parseSavedHistoryLimit(raw)).toBeNull();
  });
});
