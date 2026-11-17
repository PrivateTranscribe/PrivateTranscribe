import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const WindowsKeyManager = require("../../../src/helpers/windowsKeyManager");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A WindowsKeyManager whose "listener" is Node running `script`. start() hands
 * the listener the hotkey as its only argument, so the hotkey is the script path.
 */
function managerRunning(script: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-key-manager-"));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, "listener.js");
  fs.writeFileSync(scriptPath, script);

  const manager = new WindowsKeyManager();
  manager.isSupported = true;
  manager.resolveListenerBinary = () => process.execPath;
  return { manager, hotkey: scriptPath };
}

describe("WindowsKeyManager", () => {
  it("names the hotkey when the listener refuses it", async () => {
    const { manager, hotkey } = managerRunning(
      "process.stderr.write(\"Error: unknown key 'Bogus'\\n\"); process.exit(2);"
    );
    const errored = new Promise<Error>((resolve) => manager.once("error", resolve));

    manager.start(hotkey);
    const error = await errored;

    expect(error.message).toBe(`Windows key listener cannot watch the hotkey "${hotkey}"`);
    expect(manager.isListening()).toBe(false);
  });

  it("passes on the listener's KEY_CANCEL between its down and up", async () => {
    const { manager, hotkey } = managerRunning(
      'process.stdout.write("READY\\nKEY_DOWN\\nKEY_CANCEL\\nKEY_UP\\n"); setTimeout(() => {}, 200);'
    );
    const events: string[] = [];
    for (const name of ["key-down", "key-cancel", "key-up"]) {
      manager.on(name, () => events.push(name));
    }
    const stopped = new Promise((resolve) => manager.once("stopped", resolve));

    manager.start(hotkey);
    await stopped;

    expect(events).toEqual(["key-down", "key-cancel", "key-up"]);
  });

  it("keeps the exit code for other failures", async () => {
    const { manager, hotkey } = managerRunning("process.exit(1);");
    manager.restartDelayMs = 10;
    const errored = new Promise<Error>((resolve) => manager.once("error", resolve));

    manager.start(hotkey);

    expect((await errored).message).toBe("Windows key listener exited with code 1 signal null");
  });

  it("starts a crashed listener twice more before it reports the crash", async () => {
    // Each run appends a line, so the file counts how often the listener ran.
    const runs = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pt-key-runs-")), "runs.txt");
    tempDirs.push(path.dirname(runs));
    const { manager, hotkey } = managerRunning(
      `require("fs").appendFileSync(${JSON.stringify(runs)}, "run\\n");` +
        'process.stdout.write("READY\\n"); setTimeout(() => process.exit(3), 20);'
    );
    manager.restartDelayMs = 10;
    let readyCount = 0;
    manager.on("ready", () => (readyCount += 1));
    const errored = new Promise<any>((resolve) => manager.once("error", resolve));

    manager.start(hotkey);
    const error = await errored;

    expect(fs.readFileSync(runs, "utf8").trim().split(/\r?\n/)).toHaveLength(3);
    expect(readyCount).toBe(3);
    expect(error.reason).toBe("crashed");
    expect(error.restarts).toBe(2);
    expect(manager.isListening()).toBe(false);
  });

  it("keeps listening when one restart is enough", async () => {
    const flag = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pt-key-flag-")), "crashed");
    tempDirs.push(path.dirname(flag));
    // Crashes on its first run only, like a one-off fault.
    const { manager, hotkey } = managerRunning(
      `const fs = require("fs"); const flag = ${JSON.stringify(flag)};` +
        'process.stdout.write("READY\\n");' +
        "if (!fs.existsSync(flag)) { fs.writeFileSync(flag, ''); setTimeout(() => process.exit(3), 20); }" +
        "else { setInterval(() => {}, 1000); }"
    );
    manager.restartDelayMs = 10;
    const onError = vi.fn();
    manager.on("error", onError);
    let readyCount = 0;
    const secondReady = new Promise<void>((resolve) =>
      manager.on("ready", () => {
        readyCount += 1;
        if (readyCount === 2) resolve();
      })
    );

    manager.start(hotkey);
    await secondReady;

    expect(manager.isListening()).toBe(true);
    expect(manager.restartCount).toBe(1);
    expect(onError).not.toHaveBeenCalled();
    manager.stop();
  });

  it("does not restart a listener that refuses the hotkey", async () => {
    const { manager, hotkey } = managerRunning("process.exit(2);");
    manager.restartDelayMs = 10;
    const errored = new Promise<any>((resolve) => manager.once("error", resolve));

    manager.start(hotkey);

    expect((await errored).reason).toBe("bad_hotkey");
    expect(manager.restartCount).toBe(0);
  });

  it("does not restart after stop()", async () => {
    const { manager, hotkey } = managerRunning(
      'process.stdout.write("READY\\n"); setTimeout(() => process.exit(3), 20);'
    );
    manager.restartDelayMs = 200;
    const stopped = new Promise((resolve) => manager.once("stopped", resolve));
    manager.start(hotkey);
    await stopped;
    manager.stop();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(manager.isListening()).toBe(false);
    expect(manager.process).toBeNull();
  });
});
