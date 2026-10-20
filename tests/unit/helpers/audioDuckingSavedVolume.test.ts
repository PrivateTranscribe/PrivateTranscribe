import { describe, expect, it } from "vitest";

/**
 * The level a Windows duck saves is the level restore() puts back. Reading a
 * 0% master volume as "no value" restored it to 100% after every dictation,
 * which is a volume blast for anyone who keeps the speakers at zero. The duck
 * itself must not raise 0% either, and a level that could not be read is left
 * alone rather than guessed.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ducking = require("../../../src/helpers/audioDuckingManager.js");
const {
  AudioDuckingManager,
  parseWindowsSavedState,
  buildWindowsDuckScriptLines,
  buildWindowsRestoreScriptLines,
  shouldRepairFromState,
} = ducking;

function makeLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function makeFakeApi(initial: { volume: number; muted: boolean }) {
  const calls: string[] = [];
  const state = { ...initial };
  return {
    calls,
    api: {
      async getState() {
        return { ...state };
      },
      async setVolume(level: number) {
        calls.push(`setVolume:${level}`);
        state.volume = level;
      },
      async setMuted(muted: boolean) {
        calls.push(`setMuted:${muted}`);
        state.muted = muted;
      },
    },
  };
}

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

  it("gives no level, not 100%, when the output is not a number", () => {
    expect(parseWindowsSavedState("garbage|False").volume).toBeNull();
    expect(parseWindowsSavedState("").volume).toBeNull();
    expect(parseWindowsSavedState(undefined).volume).toBeNull();
  });
});

describe("restoring a level that could not be read", () => {
  it("puts the mute back on Windows without moving the slider", () => {
    const lines = buildWindowsRestoreScriptLines({ volume: null, muted: false });
    expect(lines.join("\n")).not.toContain("SetVolume");
    expect(lines).toEqual(["[Audio]::SetMute($false)"]);
  });

  it("still writes a real 0 back on Windows", () => {
    const lines = buildWindowsRestoreScriptLines({ volume: 0, muted: false });
    expect(lines[0]).toContain("[float]::Parse('0.0000'");
  });

  it("skips setVolume on macOS and Linux", async () => {
    const fake = makeFakeApi({ volume: NaN, muted: false });
    const manager = new AudioDuckingManager({
      platform: "linux",
      logger: makeLogger(),
      stateFilePath: null,
      platformApis: { linux: fake.api },
    });
    await manager.duck({ mode: "duck", duckLevel: 0.5 });
    await manager.restore();
    expect(fake.calls.filter((call) => call.startsWith("setVolume"))).toEqual([]);
  });
});

describe("ducking from 0%", () => {
  it("never raises the volume in the Windows script", () => {
    const lines = buildWindowsDuckScriptLines({ mode: "duck", duckLevel: 0.5, statePath: null });
    const target = lines.find((line: string) => line.startsWith("$target ="));
    expect(target).toContain("[Math]::Min($base,");
  });

  it("stays at 0 on macOS and Linux", async () => {
    const fake = makeFakeApi({ volume: 0, muted: false });
    const manager = new AudioDuckingManager({
      platform: "linux",
      logger: makeLogger(),
      stateFilePath: null,
      platformApis: { linux: fake.api },
    });
    await manager.duck({ mode: "duck", duckLevel: 0.5 });
    expect(fake.calls).toEqual(["setVolume:0"]);
    await manager.restore();
    expect(fake.calls).toEqual(["setVolume:0", "setVolume:0", "setMuted:false"]);
  });

  it("is repaired at startup from an older build's 1% floor", () => {
    // An older build ducked 0% up to 1% and crashed before its restore.
    const state = { mode: "duck", volume: 0, muted: false, duckTarget: 0.01 };
    expect(shouldRepairFromState(state, { volume: 0.01, muted: false })).toBe(true);
    // A user who turned it up past that afterwards is left alone.
    expect(shouldRepairFromState(state, { volume: 0.3, muted: false })).toBe(false);
  });

  it("is spotted by the Windows script too", () => {
    const lines = buildWindowsDuckScriptLines({
      mode: "duck",
      duckLevel: 0.5,
      statePath: null,
      previous: { mode: "duck", volume: 0, muted: false, duckTarget: 0.01 },
    });
    expect(lines.join("\n")).toContain("[Math]::Abs($vol -");
  });
});
