import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Drives the compiled windows-key-listener.exe through its `--simulate` seam.
 *
 * Simulate mode installs no hooks and never samples the real keyboard: it replays
 * scripted events from stdin through the exact same decision function the live
 * low-level hook calls. That makes the compound-hotkey timing behavior testable
 * without automating Kristian's actual keyboard.
 */

const projectRoot = path.resolve(__dirname, "..", "..", "..");
const exePath = path.join(projectRoot, "resources", "bin", "windows-key-listener.exe");
const sourcePath = path.join(projectRoot, "resources", "windows-key-listener.c");

const COMPILE_HINT =
  "Rebuild it with: cmd /c '\"C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat\" && cl /O2 /nologo resources\\windows-key-listener.c /Fe:resources\\bin\\windows-key-listener.exe user32.lib'";

function binaryStatus(): { usable: boolean; reason: string } {
  if (process.platform !== "win32") {
    return { usable: false, reason: "not running on Windows" };
  }
  if (!fs.existsSync(exePath)) {
    return { usable: false, reason: `${exePath} does not exist` };
  }
  if (fs.existsSync(sourcePath)) {
    const exeStat = fs.statSync(exePath);
    const sourceStat = fs.statSync(sourcePath);
    if (exeStat.mtimeMs < sourceStat.mtimeMs) {
      return { usable: false, reason: `${exePath} is older than windows-key-listener.c` };
    }
  }
  return { usable: true, reason: "" };
}

const status = binaryStatus();
if (!status.usable) {
  // Staleness must never fail the suite - it only means nobody compiled the fix yet.
  console.warn(
    `[windowsKeyListener.simulate] Skipping: ${status.reason}. ${
      process.platform === "win32" ? COMPILE_HINT : ""
    }`
  );
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

describe.skipIf(!status.usable)("windows-key-listener --simulate", () => {
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
