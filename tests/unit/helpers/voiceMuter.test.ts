import { describe, expect, test } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const voiceMuter = require("../../../src/helpers/voiceMuter");
const { VoiceMuter, getHoldKeyExecutablePaths, resolveHoldKeyExecutable } = voiceMuter;

describe("hold key executable resolution", () => {
  test("prefers the packaged resources directory over the dev layouts", () => {
    const paths = getHoldKeyExecutablePaths({
      resourcesPath: "C:\\app\\resources",
      cwd: "C:\\dev\\project",
      helpersDir: "C:\\dev\\project\\src\\helpers",
    });
    expect(paths[0]).toContain("C:\\app\\resources");
    expect(paths.length).toBeGreaterThan(1);
  });

  test("returns null when the helper is nowhere to be found", () => {
    expect(resolveHoldKeyExecutable({ existsSync: () => false })).toBeNull();
  });
});

describe("VoiceMuter release safety", () => {
  test("release does nothing when we never muted", async () => {
    // The rule that keeps the feature from unmuting somebody who muted
    // themselves: we only ever undo a mute we performed.
    const muter = new VoiceMuter();
    expect(muter.isMuted()).toBe(false);
    await expect(muter.release()).resolves.toBe(false);
  });

  test("hold reports failure rather than a false success when unsupported", async () => {
    const muter = new VoiceMuter();
    muter.isSupported = false;
    await expect(muter.hold("F13")).resolves.toBe(false);
    expect(muter.isMuted()).toBe(false);
  });

  test("hold refuses an empty key instead of pressing something arbitrary", async () => {
    const muter = new VoiceMuter();
    await expect(muter.hold("")).resolves.toBe(false);
    await expect(muter.hold(null)).resolves.toBe(false);
    expect(muter.isMuted()).toBe(false);
  });

  test("a second hold does not stack a second key press", async () => {
    // Two presses would need two releases to balance. If the second release
    // never came the key would stay logically down system-wide.
    const muter = new VoiceMuter();
    muter.process = { fake: true };
    muter.heldKey = "F13";
    await expect(muter.hold("F13")).resolves.toBe(true);
    expect(muter.process).toEqual({ fake: true });
  });
});
