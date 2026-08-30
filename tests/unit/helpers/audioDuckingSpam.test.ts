import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Spamming the dictation button used to walk the master volume down and leave
 * it there.
 *
 * The old manager guarded on a flag that only turned true once the platform
 * call came back — a few hundred milliseconds after the press. Inside that
 * window a second press started a second duck, which read the already-ducked
 * volume as if it were the user's own setting (1.0 → 0.5 → 0.25), and a restore
 * that arrived mid-duck was recorded as "pending" on a field the next press
 * cleared, so it never ran at all.
 *
 * Everything here uses a fake platform API with a deliberate delay standing in
 * for PowerShell. No real audio is touched.
 */

const MODULE = "../../../src/helpers/audioDuckingManager.js";

async function loadModule() {
  return (await import(MODULE)) as any;
}

let tmpDir: string;
let statePath: string;

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// A zero here means "answer immediately", so a test that installs fake timers
// does not have to advance them just to let the fake platform reply.
const sleep = (ms: number) =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * A macOS/Linux-shaped API that takes `latencyMs` to answer, the way a
 * PowerShell or pactl round trip does.
 */
function makeSlowApi(initial = { volume: 0.8, muted: false }, latencyMs = 20) {
  const order: string[] = [];
  const state = { ...initial };
  return {
    order,
    state,
    api: {
      async getState() {
        await sleep(latencyMs);
        order.push("getState");
        return { ...state };
      },
      async setVolume(level: number) {
        await sleep(latencyMs);
        order.push(`setVolume:${level.toFixed(4)}`);
        state.volume = level;
      },
      async setMuted(muted: boolean) {
        await sleep(latencyMs);
        order.push(`setMuted:${muted}`);
        state.muted = muted;
      },
    },
  };
}

function makeManager(AudioDuckingManager: any, api: any, extra: Record<string, unknown> = {}) {
  return new AudioDuckingManager({
    platform: "linux",
    logger: makeLogger(),
    stateFilePath: statePath,
    platformApis: { linux: api },
    ...extra,
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-duck-spam-"));
  statePath = path.join(tmpDir, "audio-ducking-state.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("spamming the button", () => {
  it("ducks once for five presses in a row, and restores all the way back", async () => {
    const { AudioDuckingManager } = await loadModule();
    const fake = makeSlowApi({ volume: 0.8, muted: false });
    const manager = makeManager(AudioDuckingManager, fake.api);

    // Five presses inside one platform round trip.
    await Promise.all(
      Array.from({ length: 5 }, () => manager.duck({ mode: "duck", duckLevel: 0.5 }))
    );

    expect(fake.order, "the volume was stepped down more than once").toEqual([
      "getState",
      "setVolume:0.4000",
    ]);

    await manager.restore();
    expect(fake.state.volume).toBe(0.8);
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("runs a restore that arrives mid-duck instead of letting the next press cancel it", async () => {
    const { AudioDuckingManager } = await loadModule();
    const fake = makeSlowApi({ volume: 0.8, muted: false });
    const manager = makeManager(AudioDuckingManager, fake.api);

    // start … stop … start … stop, all faster than the platform can answer.
    const presses = [
      manager.duck({ mode: "duck", duckLevel: 0.5 }),
      manager.restore(),
      manager.duck({ mode: "duck", duckLevel: 0.5 }),
      manager.restore(),
    ];
    await Promise.all(presses);

    expect(fake.state.volume, "the volume never came back to where it started").toBe(0.8);
    expect(fake.state.muted).toBe(false);
    expect(fs.existsSync(statePath)).toBe(false);
    // Never a duck of a duck: 0.4 is half of 0.8, 0.2 would be half of half.
    expect(fake.order.filter((c) => c.startsWith("setVolume:0.2"))).toEqual([]);
  });

  it("never lowers a volume that is already lowered by an un-restored duck", async () => {
    const { AudioDuckingManager } = await loadModule();
    // What a missed restore leaves behind: the file still here, volume still down.
    fs.writeFileSync(
      statePath,
      JSON.stringify({ version: 1, mode: "duck", volume: 0.8, muted: false, duckTarget: 0.4 }),
      "utf8"
    );
    const fake = makeSlowApi({ volume: 0.4, muted: false });
    const manager = makeManager(AudioDuckingManager, fake.api);

    await manager.duck({ mode: "duck", duckLevel: 0.5 });

    expect(fake.state.volume, "0.5 × an already-ducked 0.4 would be 0.2").toBe(0.4);

    await manager.restore();
    expect(fake.state.volume, "restored to the ducked level instead of the real one").toBe(0.8);
  });

  it("keeps the user's own new volume when they already fixed it themselves", async () => {
    const { AudioDuckingManager } = await loadModule();
    fs.writeFileSync(
      statePath,
      JSON.stringify({ version: 1, mode: "duck", volume: 0.8, muted: false, duckTarget: 0.4 }),
      "utf8"
    );
    // Past the baseline, so the stale file has nothing left to say.
    const fake = makeSlowApi({ volume: 0.9, muted: false });
    const manager = makeManager(AudioDuckingManager, fake.api);

    await manager.duck({ mode: "duck", duckLevel: 0.5 });
    await manager.restore();

    expect(fake.state.volume, "the stale file overrode a volume the user had chosen").toBe(0.9);
  });

  it("still returns to the real baseline when the user nudged a stranded duck part-way up", async () => {
    const { AudioDuckingManager } = await loadModule();
    fs.writeFileSync(
      statePath,
      JSON.stringify({ version: 1, mode: "duck", volume: 0.8, muted: false, duckTarget: 0.4 }),
      "utf8"
    );
    // Stranded at 0.4, nudged to 0.6 because it was too quiet to work with.
    const fake = makeSlowApi({ volume: 0.6, muted: false });
    const manager = makeManager(AudioDuckingManager, fake.api);

    await manager.duck({ mode: "duck", duckLevel: 0.5 });
    await manager.restore();

    expect(fake.state.volume, "the nudge was mistaken for the user's own level").toBe(0.8);
  });
});

describe("the backstop", () => {
  it("puts the volume back on its own when nothing ever asks", async () => {
    vi.useFakeTimers();
    try {
      const { AudioDuckingManager } = await loadModule();
      const fake = makeSlowApi({ volume: 0.8, muted: false }, 0);
      const logger = makeLogger();
      const manager = new AudioDuckingManager({
        platform: "linux",
        logger,
        stateFilePath: statePath,
        platformApis: { linux: fake.api },
        watchdogMs: 60_000,
      });

      await manager.duck({ mode: "duck", duckLevel: 0.5 });
      expect(fake.state.volume).toBe(0.4);

      // Nobody calls restore — the renderer died, or the IPC never landed.
      await vi.advanceTimersByTimeAsync(61_000);

      expect(fake.state.volume, "the volume stayed down forever").toBe(0.8);
      expect(fs.existsSync(statePath)).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("putting it back anyway"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts from the latest press, not the first", async () => {
    vi.useFakeTimers();
    try {
      const { AudioDuckingManager } = await loadModule();
      const fake = makeSlowApi({ volume: 0.8, muted: false }, 0);
      const manager = new AudioDuckingManager({
        platform: "linux",
        logger: makeLogger(),
        stateFilePath: statePath,
        platformApis: { linux: fake.api },
        watchdogMs: 60_000,
      });

      await manager.duck({ mode: "duck", duckLevel: 0.5 });
      await vi.advanceTimersByTimeAsync(50_000);
      await manager.duck({ mode: "duck", duckLevel: 0.5 });
      await vi.advanceTimersByTimeAsync(20_000);

      expect(fake.state.volume, "a re-press did not push the backstop out").toBe(0.4);

      await vi.advanceTimersByTimeAsync(45_000);
      expect(fake.state.volume).toBe(0.8);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a restore with nothing of ours ducked", () => {
  it("still finishes an earlier duck that is holding the volume down", async () => {
    const { AudioDuckingManager } = await loadModule();
    fs.writeFileSync(
      statePath,
      JSON.stringify({ version: 1, mode: "duck", volume: 0.8, muted: false, duckTarget: 0.4 }),
      "utf8"
    );
    const fake = makeSlowApi({ volume: 0.4, muted: false }, 0);
    const manager = makeManager(AudioDuckingManager, fake.api);

    await manager.restore();

    expect(fake.state.volume).toBe(0.8);
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("costs nothing when there is no state file", async () => {
    const { AudioDuckingManager } = await loadModule();
    const fake = makeSlowApi({ volume: 0.8, muted: false }, 0);
    const manager = makeManager(AudioDuckingManager, fake.api);

    await manager.restore();
    await manager.restore();

    expect(fake.order).toEqual([]);
  });
});

describe("the Windows script", () => {
  it("ducks from the un-restored baseline rather than the volume it reads", async () => {
    const { buildWindowsDuckScriptLines } = await loadModule();

    const lines: string[] = buildWindowsDuckScriptLines({
      mode: "duck",
      duckLevel: 0.5,
      statePath: "C:\\Users\\KT\\AppData\\state.json",
      previous: { mode: "duck", volume: 0.8, muted: false, duckTarget: 0.4 },
    });
    const script = lines.join("\n");

    // The still-ducked test, then the baseline swap, then a target off $base.
    // The test compares against the baseline (0.8 less the epsilon), not the
    // duck target, so a part-way nudge still counts as un-restored.
    expect(script).toContain("$vol -lt [float]::Parse('0.7800'");
    expect(script).toContain("$base = [float]::Parse('0.8000'");
    expect(script).toContain("[Math]::Max(0.01, $base *");
    // What gets reported back and written down is the baseline, not $vol.
    expect(script).toContain("Write-Output ($base.ToString('F4'");
  });

  it("reads the live volume when there is nothing un-restored to go on", async () => {
    const { buildWindowsDuckScriptLines } = await loadModule();

    const script: string = buildWindowsDuckScriptLines({
      mode: "duck",
      duckLevel: 0.5,
      statePath: null,
    }).join("\n");

    expect(script).toContain("$base = $vol");
    expect(script).not.toContain("$vol -lt");
  });

  it("puts the volume back even when the user was muted before the duck", async () => {
    const { AudioDuckingManager } = await loadModule();
    const calls: string[] = [];
    const winApi = {
      async duckAndSave() {
        return { volume: 0.8, muted: true };
      },
      async getState() {
        return { volume: 0.4, muted: true };
      },
      async restore(saved: { volume: number; muted: boolean }) {
        calls.push(`restore:${saved.volume}:${saved.muted}`);
      },
    };
    const manager = new AudioDuckingManager({
      platform: "win32",
      logger: makeLogger(),
      stateFilePath: statePath,
      platformApis: { win32: winApi },
    });

    await manager.duck({ mode: "duck", duckLevel: 0.5 });
    await manager.restore();

    // The Windows duck lowers the volume whether or not the endpoint is muted,
    // so the restore has to hand the volume back, not just the mute flag.
    expect(calls).toEqual(["restore:0.8:true"]);
  });
});
