import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The stranded-volume bug, pinned.
 *
 * Kristian's report: transcription ducking sometimes never restores — an error
 * path, or the app closed mid-duck — and the master volume stays lowered until
 * he fixes it by hand. Three things have to hold for that to stop happening:
 *
 *   1. What the volume WAS is on disk before the volume moves.
 *   2. The file is deleted only once a restore actually succeeded.
 *   3. The next start repairs from it — but ONLY if the system still looks
 *      ducked. A user who already dragged the slider back up must not have it
 *      yanked out from under them.
 *
 * Nothing here plays or changes any audio: the platform API is a fake, and the
 * Windows path is checked by reading the PowerShell the module generates.
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

/** A macOS/Linux-shaped API: read first, then set. Records the call order. */
function makeFakeApi(initial = { volume: 0.8, muted: false }) {
  const order: string[] = [];
  const state = { ...initial };
  return {
    order,
    state,
    api: {
      async getState() {
        order.push("getState");
        return { ...state };
      },
      async setVolume(level: number) {
        order.push(`setVolume:${level.toFixed(4)}`);
        state.volume = level;
      },
      async setMuted(muted: boolean) {
        order.push(`setMuted:${muted}`);
        state.muted = muted;
      },
    },
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-master-duck-"));
  statePath = path.join(tmpDir, "audio-ducking-state.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("write before the volume moves", () => {
  it("has the pre-duck state on disk before setVolume is called (darwin/linux path)", async () => {
    const { AudioDuckingManager } = await loadModule();
    const fake = makeFakeApi({ volume: 0.8, muted: false });

    let stateWhenVolumeMoved: string | null = null;
    const originalSetVolume = fake.api.setVolume;
    fake.api.setVolume = async (level: number) => {
      stateWhenVolumeMoved = fs.existsSync(statePath)
        ? fs.readFileSync(statePath, "utf8")
        : null;
      await originalSetVolume(level);
    };

    const manager = new AudioDuckingManager({
      platform: "linux",
      logger: makeLogger(),
      stateFilePath: statePath,
      platformApis: { linux: fake.api },
    });

    await manager.duck({ mode: "duck", duckLevel: 0.2 });

    expect(stateWhenVolumeMoved, "the volume moved before anything hit disk").not.toBeNull();
    const saved = JSON.parse(stateWhenVolumeMoved as unknown as string);
    expect(saved.volume).toBe(0.8);
    expect(saved.duckTarget).toBeCloseTo(0.16, 5);
    expect(fake.order).toEqual(["getState", "setVolume:0.1600"]);
  });

  it("writes the state file before it sets the volume, inside the Windows script", async () => {
    const { buildWindowsDuckScriptLines } = await loadModule();

    const lines = buildWindowsDuckScriptLines({
      mode: "duck",
      duckLevel: 0.2,
      statePath: "C:\\Users\\KT\\AppData\\state.json",
    });

    const writeIndex = lines.findIndex((l: string) => l.includes("WriteAllText"));
    const setIndex = lines.findIndex((l: string) => l.includes("[Audio]::SetVolume"));

    expect(writeIndex).toBeGreaterThan(-1);
    expect(setIndex).toBeGreaterThan(-1);
    expect(writeIndex, "the duck script lowers the volume before recording it").toBeLessThan(
      setIndex
    );
    // Invariant culture everywhere, or a Danish machine writes "0,8000".
    expect(lines.join("\n")).toContain("InvariantCulture");
  });

  it("omits the state write entirely when no path is configured", async () => {
    const { buildWindowsDuckScriptLines } = await loadModule();
    const lines = buildWindowsDuckScriptLines({ mode: "duck", duckLevel: 0.2, statePath: null });
    expect(lines.join("\n")).not.toContain("WriteAllText");
  });
});

describe("the file's lifetime", () => {
  it("is deleted on a successful restore", async () => {
    const { AudioDuckingManager } = await loadModule();
    const fake = makeFakeApi();
    const manager = new AudioDuckingManager({
      platform: "linux",
      logger: makeLogger(),
      stateFilePath: statePath,
      platformApis: { linux: fake.api },
    });

    await manager.duck({ mode: "duck", duckLevel: 0.2 });
    expect(fs.existsSync(statePath)).toBe(true);

    await manager.restore();

    expect(fs.existsSync(statePath)).toBe(false);
    expect(fake.state.volume).toBe(0.8);
  });

  it("survives a failing restore, so the next start can finish the job", async () => {
    const { AudioDuckingManager } = await loadModule();
    const fake = makeFakeApi();
    const manager = new AudioDuckingManager({
      platform: "linux",
      logger: makeLogger(),
      stateFilePath: statePath,
      platformApis: { linux: fake.api },
    });

    await manager.duck({ mode: "duck", duckLevel: 0.2 });
    fake.api.setVolume = async () => {
      throw new Error("pactl is gone");
    };

    await manager.restore();

    expect(fs.existsSync(statePath), "a failed restore threw the evidence away").toBe(true);
  });
});

describe("the repair rule", () => {
  it("restores when the system still looks ducked", async () => {
    const { AudioDuckingManager } = await loadModule();
    fs.writeFileSync(
      statePath,
      JSON.stringify({ version: 1, mode: "duck", volume: 0.8, muted: false, duckTarget: 0.16 }),
      "utf8"
    );
    // Where a killed run would have left it.
    const fake = makeFakeApi({ volume: 0.16, muted: false });
    const logger = makeLogger();
    const manager = new AudioDuckingManager({
      platform: "linux",
      logger,
      stateFilePath: statePath,
      platformApis: { linux: fake.api },
    });

    const result = await manager.repairFromDisk();

    expect(result.repaired).toBe(true);
    expect(fake.state.volume).toBe(0.8);
    expect(fs.existsSync(statePath)).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Repaired a stranded duck"));
  });

  it("leaves the volume alone when the user already fixed it, and just drops the file", async () => {
    const { AudioDuckingManager } = await loadModule();
    fs.writeFileSync(
      statePath,
      JSON.stringify({ version: 1, mode: "duck", volume: 0.8, muted: false, duckTarget: 0.16 }),
      "utf8"
    );
    // The user dragged the slider back up to something of their own choosing.
    const fake = makeFakeApi({ volume: 0.55, muted: false });
    const logger = makeLogger();
    const manager = new AudioDuckingManager({
      platform: "linux",
      logger,
      stateFilePath: statePath,
      platformApis: { linux: fake.api },
    });

    const result = await manager.repairFromDisk();

    expect(result.repaired).toBe(false);
    expect(result.reason).toBe("already-restored");
    expect(fake.state.volume, "the repair overwrote a volume the user had chosen").toBe(0.55);
    expect(fs.existsSync(statePath)).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("leaving it alone"));
  });

  it("treats a volume a hair above the target as still ducked (float rounding)", async () => {
    const { shouldRepairFromState, STILL_DUCKED_EPSILON } = await loadModule();
    const state = { mode: "duck", volume: 0.8, duckTarget: 0.16 };

    expect(shouldRepairFromState(state, { volume: 0.16 })).toBe(true);
    expect(shouldRepairFromState(state, { volume: 0.16 + STILL_DUCKED_EPSILON / 2 })).toBe(true);
    expect(shouldRepairFromState(state, { volume: 0.16 + STILL_DUCKED_EPSILON * 2 })).toBe(false);
  });

  it("uses the mute flag rather than a level when the duck was a mute", async () => {
    const { shouldRepairFromState } = await loadModule();
    const state = { mode: "mute", volume: 0.8, muted: false, duckTarget: 0.8 };

    expect(shouldRepairFromState(state, { volume: 0.8, muted: true })).toBe(true);
    expect(shouldRepairFromState(state, { volume: 0.8, muted: false })).toBe(false);
  });

  it("does nothing at all when there is no state file", async () => {
    const { AudioDuckingManager } = await loadModule();
    const fake = makeFakeApi();
    const manager = new AudioDuckingManager({
      platform: "linux",
      logger: makeLogger(),
      stateFilePath: statePath,
      platformApis: { linux: fake.api },
    });

    expect((await manager.repairFromDisk()).reason).toBe("no-state-file");
    expect(fake.order).toEqual([]);
  });

  it("drops a state file it cannot act on rather than leaving it forever", async () => {
    const { AudioDuckingManager } = await loadModule();
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, mode: "duck", volume: 0.8 }), "utf8");
    const manager = new AudioDuckingManager({
      platform: "sunos",
      logger: makeLogger(),
      stateFilePath: statePath,
      platformApis: {},
    });

    const result = await manager.repairFromDisk();

    expect(result.reason).toBe("unsupported-platform");
    expect(fs.existsSync(statePath)).toBe(false);
  });
});

describe("unsupported platform", () => {
  it("never writes a state file and never touches audio", async () => {
    const { AudioDuckingManager } = await loadModule();
    const logger = makeLogger();
    const manager = new AudioDuckingManager({
      platform: "sunos",
      logger,
      stateFilePath: statePath,
      platformApis: {},
    });

    await manager.duck({ mode: "duck", duckLevel: 0.2 });
    await manager.restore();

    expect(fs.existsSync(statePath)).toBe(false);
    expect(logger.debug).toHaveBeenCalledWith("[AudioDucking] Unsupported platform:", "sunos");
  });
});
