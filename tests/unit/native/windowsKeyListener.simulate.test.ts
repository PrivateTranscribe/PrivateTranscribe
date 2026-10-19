import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Drives windows-key-listener.exe through its `--simulate` seam.
 *
 * Simulate mode installs no hooks and never samples the real keyboard: it replays
 * scripted events from stdin through the exact same decision function the live
 * low-level hook calls. That makes the compound-hotkey timing behavior testable
 * without automating Kristian's actual keyboard.
 *
 * The suite compiles the listener from the current source with the compiler
 * search `npm run compile:winkeys` uses, so it never tests a stale binary. A
 * build is reused while the source and that search are unchanged.
 */

const { compileKeyListener } = require("../../../scripts/lib/compile-key-listener");

const projectRoot = path.resolve(__dirname, "..", "..", "..");
const sourcePath = path.join(projectRoot, "resources", "windows-key-listener.c");
const compilerPath = path.join(projectRoot, "scripts", "lib", "compile-key-listener.js");

function buildListener(): { exePath: string; reason: string } {
  if (process.platform !== "win32") {
    return { exePath: "", reason: "not running on Windows" };
  }

  const hash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(sourcePath))
    .update(fs.readFileSync(compilerPath))
    .digest("hex")
    .slice(0, 16);
  const exePath = path.join(os.tmpdir(), `pt-key-listener-${hash}.exe`);
  if (fs.existsSync(exePath)) {
    return { exePath, reason: "" };
  }

  // Build beside the final name and rename, so a parallel run never starts a
  // half-written binary.
  const staging = path.join(os.tmpdir(), `pt-key-listener-${hash}-${process.pid}.exe`);
  const { compiler, failures } = compileKeyListener({
    source: sourcePath,
    output: staging,
    quiet: true,
  });
  if (!compiler) {
    // A missing compiler skips the suite; a source that does not compile fails it.
    if (failures.length > 0) {
      throw new Error(
        `windows-key-listener.c did not compile:\n${failures
          .map(
            (failure: { compiler: string; output: string }) =>
              `${failure.compiler}:\n${failure.output}`
          )
          .join("\n\n")}`
      );
    }
    return {
      exePath: "",
      reason: "no C compiler found. Install Visual Studio Build Tools with the C++ workload",
    };
  }
  try {
    fs.renameSync(staging, exePath);
  } catch {
    // Another run got there first; its binary comes from the same source.
    if (!fs.existsSync(exePath)) return { exePath: staging, reason: "" };
    fs.rmSync(staging, { force: true });
  }
  return { exePath, reason: "" };
}

const { exePath, reason } = buildListener();
if (!exePath) {
  console.warn(`[windowsKeyListener.simulate] Skipping: ${reason}.`);
}

/**
 * Spawns the listener in simulate mode, feeds it the scripted lines, and returns
 * the emitted KEY_DOWN / KEY_UP sequence in order.
 */
function runScript(hotkey: string, lines: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, ["--simulate", hotkey], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let settled = false;
    let sawReady = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(
        new Error(`Timed out waiting for ${hotkey}. stdout so far: ${JSON.stringify(stdout)}`)
      );
    }, 5000);

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        reject(err);
        return;
      }
      resolve(
        stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line === "KEY_DOWN" || line === "KEY_UP")
      );
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (!sawReady && stdout.includes("READY")) {
        sawReady = true;
        // Write only after READY so the script can never race process startup.
        child.stdin.write(lines.join("\n") + "\nQUIT\n");
        child.stdin.end();
      }
    });

    child.on("error", (err) => finish(err));
    child.on("close", () => finish());
  });
}

describe.skipIf(!exePath)("windows-key-listener --simulate", () => {
  test("ordered press still works: modifier first, then trigger", async () => {
    const events = await runScript("CommandOrControl+Space", [
      "DOWN LCTRL 0",
      "DOWN SPACE 50",
      "UP SPACE 500",
    ]);

    expect(events).toEqual(["KEY_DOWN", "KEY_UP"]);
  });

  test("simultaneous press registers when the trigger lands before the modifier", async () => {
    const events = await runScript("CommandOrControl+Space", [
      "DOWN SPACE 0",
      "DOWN LCTRL 40",
      "UP SPACE 400",
    ]);

    expect(events).toEqual(["KEY_DOWN", "KEY_UP"]);
  });

  test("a 50ms gap between trigger and modifier still counts as together", async () => {
    const events = await runScript("CommandOrControl+Space", ["DOWN SPACE 0", "DOWN LCTRL 50"]);

    expect(events).toEqual(["KEY_DOWN"]);
  });

  test("a modifier arriving long after the trigger does not fire", async () => {
    const events = await runScript("CommandOrControl+Space", ["DOWN SPACE 0", "DOWN LCTRL 500"]);

    expect(events).toEqual([]);
  });

  test("auto-repeat of the trigger does not extend the grace window", async () => {
    const repeats: string[] = [];
    for (let time = 30; time <= 390; time += 30) {
      repeats.push(`DOWN SPACE ${time}`);
    }

    const events = await runScript("CommandOrControl+Space", [
      "DOWN SPACE 0",
      ...repeats,
      "DOWN LCTRL 400",
    ]);

    expect(events).toEqual([]);
  });

  test("releasing the modifier ends the press", async () => {
    const events = await runScript("CommandOrControl+Space", [
      "DOWN SPACE 0",
      "DOWN LCTRL 40",
      "UP LCTRL 1000",
      "UP SPACE 1100",
    ]);

    expect(events).toEqual(["KEY_DOWN", "KEY_UP"]);
  });

  test("two required modifiers arriving late emit exactly one down", async () => {
    const events = await runScript("Ctrl+Shift+Space", [
      "DOWN SPACE 0",
      "DOWN LCTRL 20",
      "DOWN LSHIFT 45",
      "UP SPACE 600",
    ]);

    expect(events).toEqual(["KEY_DOWN", "KEY_UP"]);
  });

  test("a bare trigger with no modifiers is unaffected", async () => {
    const events = await runScript("Space", ["DOWN SPACE 0", "UP SPACE 300"]);

    expect(events).toEqual(["KEY_DOWN", "KEY_UP"]);
  });

  test("modifier-only combos keep working", async () => {
    const events = await runScript("Control+Super", [
      "DOWN LCTRL 0",
      "DOWN LWIN 10",
      "UP LWIN 400",
    ]);

    expect(events).toEqual(["KEY_DOWN", "KEY_UP"]);
  });

  test("the right-hand modifier re-arms just like the left", async () => {
    const events = await runScript("CommandOrControl+Space", ["DOWN SPACE 0", "DOWN RCTRL 40"]);

    expect(events).toEqual(["KEY_DOWN"]);
  });
});
