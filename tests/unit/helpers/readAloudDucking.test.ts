import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The decisions behind per-app ducking, pinned without touching a single
 * volume.
 *
 * What matters here is not that PowerShell can be spawned — it is that the
 * right sessions are chosen, that the restore list is on disk BEFORE anything
 * is lowered, and that a run which cannot duck (wrong platform, diagnostic
 * flag) does nothing at all rather than half of something.
 *
 * Dependencies are injected rather than vi.mock'd: `require("electron")` and
 * `require("child_process")` inside src/helpers are CommonJS and vitest cannot
 * replace them, so the helper takes a fake PowerShell runner and a temp-dir
 * state file instead.
 */

const MODULE = "../../../src/helpers/readAloudDucking.js";

async function load() {
  const mod: any = await import(MODULE);
  return mod.default ?? mod;
}

async function loadHelpers() {
  return (await import(MODULE)) as any;
}

/** One real session instance identifier, pipes and backslashes included. */
const REAL_ID =
  "{0.0.0.00000000}.{2f65de71-a887-45cf-9bdd-f18b9b4d34f3}|\\Device\\HarddiskVolume4\\Program Files\\Spotify\\Spotify.exe%b{00000000-0000-0000-0000-000000000000}%b0000000000";
const OTHER_ID = `${REAL_ID}-second`;

let tmpDir: string;
let statePath: string;

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

beforeEach(() => {
  delete process.env.PRIVATETRANSCRIBE_DIAG_DISABLE_AUDIO_DUCKING;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-duck-"));
  statePath = path.join(tmpDir, "state.txt");
});

afterEach(() => {
  delete process.env.PRIVATETRANSCRIBE_DIAG_DISABLE_AUDIO_DUCKING;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("session filtering", () => {
  it("excludes our own process tree, PID 0, and the system-sounds session", async () => {
    const { shouldDuckSession, selectDuckableSessions } = await loadHelpers();
    const excluded = [4242, 4243, 4244];

    const sessions = [
      { pid: 9001, systemSounds: false, state: 1, instanceId: "spotify" },
      { pid: 4243, systemSounds: false, state: 1, instanceId: "our-renderer" },
      { pid: 0, systemSounds: true, state: 0, instanceId: "system-sounds" },
      { pid: 9002, systemSounds: true, state: 1, instanceId: "sounds-with-a-pid" },
      { pid: 9003, systemSounds: false, state: 2, instanceId: "expired" },
    ];

    expect(selectDuckableSessions(sessions, excluded).map((s: any) => s.instanceId)).toEqual([
      "spotify",
    ]);
    expect(shouldDuckSession(sessions[1], excluded)).toBe(false);
    expect(shouldDuckSession(sessions[2], excluded)).toBe(false);
    expect(shouldDuckSession(null, excluded)).toBe(false);
  });

  it("builds the exclusion list from process.pid plus every app metric PID", async () => {
    const { buildExcludedPids } = await loadHelpers();

    // getAppMetrics() reports main, renderers, GPU and — the one that matters —
    // the Chromium audio service that actually owns our playback session.
    const metrics = [{ pid: 4242, type: "Browser" }, { pid: 4243 }, { pid: 4244 }, { pid: 4242 }];

    expect(buildExcludedPids(4242, metrics)).toEqual([4242, 4243, 4244]);
  });

  it("drops junk PIDs rather than passing 0 or NaN into the exclusion set", async () => {
    const { buildExcludedPids } = await loadHelpers();
    expect(buildExcludedPids(4242, [{ pid: 0 }, { pid: -1 }, { pid: null }, {}, 7])).toEqual([
      7, 4242,
    ]);
  });
});

describe("parsing", () => {
  it("keeps an instance identifier intact even though it contains pipes", async () => {
    const { parseDuckedList } = await loadHelpers();

    const rows = parseDuckedList(`9001|0.6200|0.1860|${REAL_ID}\n`);

    expect(rows).toHaveLength(1);
    expect(rows[0].instanceId).toBe(REAL_ID);
    expect(rows[0].priorVolume).toBe("0.6200");
    expect(rows[0].duckedVolume).toBe("0.1860");
  });

  it("ignores the state-file header and any malformed line", async () => {
    const { parseDuckedList } = await loadHelpers();

    const rows = parseDuckedList(
      ["# readaloud-ducking v1 2026-08-24T00:00:00Z fraction=0.3000", "", "garbage", "9001|0.5000|0.1500|id"].join(
        "\n"
      )
    );

    expect(rows.map((r: any) => r.pid)).toEqual([9001]);
  });
});

describe("duck", () => {
  it("passes the exclusion list and the state path into the script, and saves what was ducked", async () => {
    const ReadAloudDucking = await load();
    const runPowerShell = vi.fn(async () => `9001|0.6200|0.1860|${REAL_ID}`);

    const ducking = new ReadAloudDucking({
      platform: "win32",
      logger: makeLogger(),
      runPowerShell,
      stateFilePath: statePath,
      getExcludedPids: () => [4242, 4243],
    });

    await ducking.duckOthers();

    const script = runPowerShell.mock.calls[0][0] as string;
    expect(script).toContain("[int[]]@(4242,4243)");
    expect(script).toContain(statePath);
    expect(script).toContain("0.3000");

    const status = ducking.getStatus();
    expect(status.ducked).toBe(true);
    expect(status.sessions).toBe(1);
  });

  it("writes the restore list to disk before the volumes move", async () => {
    const ReadAloudDucking = await load();

    // The real ordering guarantee lives inside the C#, which writes the file
    // between its collect pass and its apply pass. This asserts the JS half of
    // the contract: the path reaches the script, and the file is on disk by the
    // time duckOthers() resolves.
    let stateAtScriptTime: string | null = null;
    const runPowerShell = vi.fn(async (script: string) => {
      // Stand in for the C#: write the file, THEN report what was changed.
      fs.writeFileSync(statePath, `# header\n9001|0.6200|0.1860|${REAL_ID}\n`, "utf8");
      stateAtScriptTime = fs.readFileSync(statePath, "utf8");
      expect(script).toContain(statePath);
      return `9001|0.6200|0.1860|${REAL_ID}`;
    });

    const ducking = new ReadAloudDucking({
      platform: "win32",
      logger: makeLogger(),
      runPowerShell,
      stateFilePath: statePath,
      getExcludedPids: () => [],
    });

    await ducking.duckOthers();

    expect(stateAtScriptTime).toContain(REAL_ID);
    expect(fs.existsSync(statePath)).toBe(true);
    expect(fs.readFileSync(statePath, "utf8")).toContain("0.6200");
  });

  it("is idempotent - a second duck while already ducked runs nothing", async () => {
    const ReadAloudDucking = await load();
    const runPowerShell = vi.fn(async () => `9001|0.6200|0.1860|${REAL_ID}`);
    const ducking = new ReadAloudDucking({
      platform: "win32",
      logger: makeLogger(),
      runPowerShell,
      stateFilePath: statePath,
      getExcludedPids: () => [],
    });

    await ducking.duckOthers();
    await ducking.duckOthers();

    expect(runPowerShell).toHaveBeenCalledTimes(1);
  });

  it("keeps the state file when the duck throws, because that is the stranding case", async () => {
    const ReadAloudDucking = await load();
    const logger = makeLogger();
    const ducking = new ReadAloudDucking({
      platform: "win32",
      logger,
      runPowerShell: vi.fn(async () => {
        fs.writeFileSync(statePath, `# header\n9001|0.6200|0.1860|${REAL_ID}\n`, "utf8");
        throw new Error("powershell died");
      }),
      stateFilePath: statePath,
      getExcludedPids: () => [],
    });

    await ducking.duckOthers();

    expect(fs.existsSync(statePath)).toBe(true);
    expect(ducking.getStatus().lastReason).toBe("duck-failed");
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("restore", () => {
  it("puts every session back to its exact prior level and then deletes the file", async () => {
    const ReadAloudDucking = await load();
    const scripts: string[] = [];
    const runPowerShell = vi.fn(async (script: string) => {
      scripts.push(script);
      if (script.includes("DuckOthers")) {
        return [`9001|0.6200|0.1860|${REAL_ID}`, `9002|0.4500|0.1350|${OTHER_ID}`].join("\n");
      }
      return "restored=2";
    });

    const ducking = new ReadAloudDucking({
      platform: "win32",
      logger: makeLogger(),
      runPowerShell,
      stateFilePath: statePath,
      getExcludedPids: () => [],
    });

    await ducking.duckOthers();
    expect(fs.existsSync(statePath)).toBe(true);

    await ducking.restore();

    const restoreScript = scripts[1];
    expect(restoreScript).toContain("0.6200");
    expect(restoreScript).toContain("0.4500");
    expect(restoreScript).toContain(REAL_ID);
    expect(ducking.getStatus().ducked).toBe(false);
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("keeps the state file when the restore itself fails", async () => {
    const ReadAloudDucking = await load();
    const ducking = new ReadAloudDucking({
      platform: "win32",
      logger: makeLogger(),
      runPowerShell: vi.fn(async (script: string) => {
        if (script.includes("DuckOthers")) return `9001|0.6200|0.1860|${REAL_ID}`;
        throw new Error("restore blew up");
      }),
      stateFilePath: statePath,
      getExcludedPids: () => [],
    });

    await ducking.duckOthers();
    await ducking.restore();

    expect(fs.existsSync(statePath)).toBe(true);
    expect(ducking.getStatus().lastReason).toBe("restore-failed");
  });
});

describe("crash repair", () => {
  it("restores from a state file left behind by a killed run, then clears it", async () => {
    const ReadAloudDucking = await load();
    fs.writeFileSync(
      statePath,
      ["# readaloud-ducking v1 2026-08-24T00:00:00Z fraction=0.3000", `9001|0.6200|0.1860|${REAL_ID}`].join(
        "\n"
      ),
      "utf8"
    );

    const runPowerShell = vi.fn(async () => "restored=1");
    const ducking = new ReadAloudDucking({
      platform: "win32",
      logger: makeLogger(),
      runPowerShell,
      stateFilePath: statePath,
    });

    const result = await ducking.repairFromDisk();

    expect(result.repaired).toBe(true);
    expect(result.restored).toBe(1);
    expect(runPowerShell.mock.calls[0][0]).toContain("0.6200");
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("does nothing when there is no state file", async () => {
    const ReadAloudDucking = await load();
    const runPowerShell = vi.fn();
    const ducking = new ReadAloudDucking({
      platform: "win32",
      logger: makeLogger(),
      runPowerShell,
      stateFilePath: statePath,
    });

    expect((await ducking.repairFromDisk()).reason).toBe("no-state-file");
    expect(runPowerShell).not.toHaveBeenCalled();
  });
});

describe("does nothing it should not", () => {
  it("is a no-op with a debug log off Windows", async () => {
    const ReadAloudDucking = await load();
    const logger = makeLogger();
    const runPowerShell = vi.fn();
    const ducking = new ReadAloudDucking({
      platform: "darwin",
      logger,
      runPowerShell,
      stateFilePath: statePath,
      getExcludedPids: () => [],
    });

    await ducking.duckOthers();
    await ducking.restore();

    expect(runPowerShell).not.toHaveBeenCalled();
    expect(fs.existsSync(statePath)).toBe(false);
    expect(ducking.getStatus().supported).toBe(false);
    expect(ducking.getStatus().lastReason).toBe("unsupported-platform");
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("No per-app ducking on darwin")
    );
  });

  it("touches no audio when the diagnostic flag is set, but still counts the request", async () => {
    process.env.PRIVATETRANSCRIBE_DIAG_DISABLE_AUDIO_DUCKING = "1";
    const ReadAloudDucking = await load();
    const runPowerShell = vi.fn();
    const ducking = new ReadAloudDucking({
      platform: "win32",
      logger: makeLogger(),
      runPowerShell,
      stateFilePath: statePath,
      getExcludedPids: () => [],
    });

    await ducking.duckOthers();
    await ducking.restore();

    expect(runPowerShell).not.toHaveBeenCalled();
    const status = ducking.getStatus();
    expect(status.duckRequests).toBe(1);
    expect(status.restoreRequests).toBe(1);
    expect(status.duckCalls).toBe(0);
    expect(status.lastReason).toBe("diagnostic-flag");
  });
});
