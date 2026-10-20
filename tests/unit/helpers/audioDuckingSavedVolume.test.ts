import { describe, expect, it } from "vitest";

/**
 * The level a Windows duck saves is the level restore() puts back. Reading a
 * 0% master volume as "no value" restored it to 100% after every dictation,
 * which is a volume blast for anyone who keeps the speakers at zero.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseWindowsSavedState } = require("../../../src/helpers/audioDuckingManager.js");

describe("the volume a Windows duck saves", () => {
  it("keeps a master volume of 0 as 0", () => {
    expect(parseWindowsSavedState("0.0000|False\r\n")).toEqual({ volume: 0, muted: false });
  });

  it("keeps 0 for a user who is also muted", () => {
    expect(parseWindowsSavedState("0.0000|True")).toEqual({ volume: 0, muted: true });
  });

  it("reads an ordinary level as it is", () => {
    expect(parseWindowsSavedState("0.8000|False")).toEqual({ volume: 0.8, muted: false });
  });

  it("falls back to full volume only when the output is not a number", () => {
    expect(parseWindowsSavedState("garbage|False").volume).toBe(1);
    expect(parseWindowsSavedState("").volume).toBe(1);
    expect(parseWindowsSavedState(undefined).volume).toBe(1);
  });
});
