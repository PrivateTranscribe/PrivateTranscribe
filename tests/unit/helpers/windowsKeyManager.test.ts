import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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
    const errored = new Promise<Error>((resolve) => manager.once("error", resolve));

    manager.start(hotkey);

    expect((await errored).message).toBe("Windows key listener exited with code 1 signal null");
  });
});
