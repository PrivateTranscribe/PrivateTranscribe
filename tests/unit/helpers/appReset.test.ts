import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  RESET_MARKER,
  requestAppReset,
  finishPendingReset,
  describeResetLeftovers,
} = require("../../../src/helpers/appReset");

/** The files a real data folder holds that a reset must not leave behind. */
const USER_DATA_FILES = [
  "keys.enc",
  ".env",
  "transcriptions.db",
  "transcriptions.db-wal",
  "logs/debug-2026-10-19T10-00-00.log",
  "Local Storage/leveldb/000003.log",
  "Local Storage/leveldb/LOCK",
  "Network/Cookies",
  "Crashpad/reports/0f1e2d3c.dmp",
  "converse-sessions.json",
  "bin/whisper-server-cuda.exe",
];

const MODEL_FILE = ".cache/PrivateTranscribe/whisper-models/ggml-base.bin";

const busy = (target: string) =>
  Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${target}'`), {
    code: "EBUSY",
  });

/** Make fs.rmSync fail for these paths, the way Windows does for an open file. */
function lockPaths(...locked: string[]) {
  const realRmSync = fs.rmSync.bind(fs);
  return vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
    if (locked.includes(String(target))) throw busy(String(target));
    return realRmSync(target, options);
  });
}

describe("app data reset", () => {
  let root: string;
  let userData: string;
  let home: string;

  const write = (base: string, relative: string, contents = "x") => {
    const file = path.join(base, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    return file;
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pt-reset-"));
    userData = path.join(root, "userData");
    home = path.join(root, "home");
    for (const file of USER_DATA_FILES) write(userData, file);
    write(home, MODEL_FILE);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("leaves no keys, history, logs or Local Storage after the restart", async () => {
    await requestAppReset({ userDataPath: userData, homeDir: home });

    const outcome = finishPendingReset(userData);

    expect(outcome).toEqual({ survivors: [] });
    expect(fs.readdirSync(userData)).toEqual([]);
  });

  it("does not delete the data folder from the running app", async () => {
    // The running app holds these open, which is what stopped the old delete
    // at the first file. Nothing in the folder is touched before the restart.
    const rmSync = vi.spyOn(fs, "rmSync");

    await requestAppReset({ userDataPath: userData, homeDir: home });

    const touched = rmSync.mock.calls.map(([target]) => String(target));
    expect(touched.some((target) => target.startsWith(userData))).toBe(false);
    expect(fs.existsSync(path.join(userData, RESET_MARKER))).toBe(true);
  });

  it("clears the model caches once the engines have let go of them", async () => {
    const modelFile = path.join(home, ...MODEL_FILE.split("/"));
    let modelPresentWhileReleasing: boolean | null = null;
    const releaseModelFiles = vi.fn(async () => {
      modelPresentWhileReleasing = fs.existsSync(modelFile);
    });

    await requestAppReset({ userDataPath: userData, homeDir: home, releaseModelFiles });

    expect(releaseModelFiles).toHaveBeenCalledTimes(1);
    expect(modelPresentWhileReleasing).toBe(true);
    expect(fs.existsSync(path.join(home, ".cache", "PrivateTranscribe"))).toBe(false);
  });

  it("carries on past a file it cannot delete and names exactly that file", async () => {
    await requestAppReset({ userDataPath: userData, homeDir: home });
    const lockedLog = path.join(userData, "logs", "debug-2026-10-19T10-00-00.log");
    lockPaths(lockedLog);

    const outcome = finishPendingReset(userData);

    expect(outcome).toEqual({ survivors: [lockedLog] });
    // Everything else went, the keys and the history included.
    expect(fs.readdirSync(userData)).toEqual(["logs"]);
    expect(fs.readdirSync(path.join(userData, "logs"))).toEqual(["debug-2026-10-19T10-00-00.log"]);
  });

  it("lists model files the running app could not delete with what the restart left", async () => {
    const modelFile = path.join(home, ...MODEL_FILE.split("/"));
    lockPaths(modelFile);

    const { cacheSurvivors } = await requestAppReset({ userDataPath: userData, homeDir: home });
    vi.restoreAllMocks();
    const outcome = finishPendingReset(userData);

    expect(cacheSurvivors).toEqual([modelFile]);
    expect(outcome?.survivors).toEqual([modelFile]);
  });

  it("only lists the paths the marker names, never deletes them", () => {
    const elsewhere = write(root, "Documents/notes.txt");
    fs.writeFileSync(
      path.join(userData, RESET_MARKER),
      JSON.stringify({ cacheSurvivors: [elsewhere, 42] })
    );

    const outcome = finishPendingReset(userData);

    expect(outcome?.survivors).toEqual([elsewhere]);
    expect(fs.existsSync(elsewhere)).toBe(true);
  });

  it("leaves the single-instance lock file this process holds", async () => {
    write(userData, "lockfile");
    await requestAppReset({ userDataPath: userData, homeDir: home });

    const outcome = finishPendingReset(userData);

    expect(outcome).toEqual({ survivors: [] });
    expect(fs.readdirSync(userData)).toEqual(["lockfile"]);
  });

  it("removes a junction without following it out of the data folder", async () => {
    const outside = write(root, "outside/keep.txt");
    fs.symlinkSync(path.dirname(outside), path.join(userData, "linked"), "junction");
    await requestAppReset({ userDataPath: userData, homeDir: home });

    finishPendingReset(userData);

    expect(fs.existsSync(path.join(userData, "linked"))).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it("does nothing on a start with no reset pending", () => {
    expect(finishPendingReset(userData)).toBeNull();
    expect(fs.existsSync(path.join(userData, "keys.enc"))).toBe(true);
  });

  it("still finishes a reset whose marker cannot be parsed", () => {
    fs.writeFileSync(path.join(userData, RESET_MARKER), "{not json");

    expect(finishPendingReset(userData)).toEqual({ survivors: [] });
    expect(fs.readdirSync(userData)).toEqual([]);
  });

  it("fails before deleting anything when the marker cannot be written", async () => {
    const notAFolder = write(root, "occupied");
    const releaseModelFiles = vi.fn();

    await expect(
      requestAppReset({ userDataPath: notAFolder, homeDir: home, releaseModelFiles })
    ).rejects.toThrow();

    expect(releaseModelFiles).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, ...MODEL_FILE.split("/")))).toBe(true);
  });

  it("caps the list it shows", () => {
    const paths = Array.from({ length: 15 }, (_, index) => `C:\\data\\file-${index}`);

    const detail = describeResetLeftovers(paths);

    expect(detail).toContain("C:\\data\\file-11");
    expect(detail).not.toContain("C:\\data\\file-12");
    expect(detail).toContain("...and 3 more");
  });
});

/**
 * The wiring around the helper lives in main.js and ipcHandlers.js, which load
 * Electron, so it is checked in their source like the other main-process wiring.
 */
describe("app data reset wiring", () => {
  const read = (...segments: string[]) =>
    fs.readFileSync(path.join(process.cwd(), ...segments), "utf8").replace(/\r\n/g, "\n");

  it("restarts through the normal quit instead of deleting in the running app", () => {
    const source = read("src", "helpers", "ipcHandlers.js");
    const start = source.indexOf('ipcMain.handle("cleanup-app"');
    const handler = source.slice(start, source.indexOf("ipcMain.handle(", start + 1));

    expect(handler).toContain("requestAppReset({");
    expect(handler).toContain("app.relaunch();");
    // before-quit is what stops the servers and closes the windows.
    expect(handler).toContain("app.quit();");
    expect(handler).not.toContain("app.exit(");
    expect(handler).not.toContain("rmSync");
  });

  it("finishes a pending reset at startup, before crash capture, only with the lock", () => {
    const source = read("main.js");
    const lock = source.indexOf("app.requestSingleInstanceLock()");
    const finish = source.indexOf(".finishPendingReset(");
    const crashCapture = source.indexOf(".startCrashCapture()");

    expect(lock).toBeGreaterThan(-1);
    expect(finish).toBeGreaterThan(lock);
    expect(crashCapture).toBeGreaterThan(finish);
    expect(source.slice(lock, finish)).toContain("if (gotSingleInstanceLock) {");
  });

  it("tells the user what a reset left behind", () => {
    const source = read("main.js");

    expect(source).toContain("appResetOutcome?.survivors.length > 0");
    expect(source).toContain("describeResetLeftovers(appResetOutcome.survivors)");
  });

  it("does not tell the user the data is gone before the restart removes it", () => {
    const source = read("src", "components", "SettingsPage.tsx");

    expect(source).not.toContain("All app data has been removed");
  });
});
