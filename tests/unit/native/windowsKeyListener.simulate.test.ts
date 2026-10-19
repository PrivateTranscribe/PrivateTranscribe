import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { CODE_TO_KEY } from "../../../src/components/ui/HotkeyInput";

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

interface ListenerRun {
  /** The process exit code. */
  code: number | null;
  /** Whether it printed READY, which it does only for a hotkey it can watch. */
  ready: boolean;
  /** The KEY_DOWN / KEY_UP lines, in order. */
  events: string[];
  stderr: string;
}

/**
 * Spawns the listener in simulate mode and, once it is READY, feeds it the
 * scripted lines. A listener that refuses the hotkey exits without READY.
 */
function runListener(hotkey: string, lines: string[] = []): Promise<ListenerRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, ["--simulate", hotkey], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
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

    const finish = (code: number | null, err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        reject(err);
        return;
      }
      resolve({
        code,
        ready: sawReady,
        events: stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line === "KEY_DOWN" || line === "KEY_UP"),
        stderr,
      });
    };

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
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

    child.on("error", (err) => finish(null, err));
    child.on("close", (code) => finish(code));
  });
}

/** The emitted KEY_DOWN / KEY_UP sequence for a scripted run. */
async function runScript(hotkey: string, lines: string[]): Promise<string[]> {
  return (await runListener(hotkey, lines)).events;
}

/** A virtual-key code as the simulate script takes it. */
const hex = (vk: number) => `0x${vk.toString(16).toUpperCase()}`;

/**
 * The virtual-key code Windows reports for each key name the hotkey picker can
 * save. Letters and digits are their own character codes.
 */
const PICKER_KEY_VK: Record<string, number> = {
  "`": 0xc0,
  "-": 0xbd,
  "=": 0xbb,
  "[": 0xdb,
  "]": 0xdd,
  "\\": 0xdc,
  ";": 0xba,
  "'": 0xde,
  ",": 0xbc,
  ".": 0xbe,
  "/": 0xbf,
  Space: 0x20,
  Tab: 0x09,
  Enter: 0x0d,
  ...Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`F${i + 1}`, 0x70 + i])),
  Up: 0x26,
  Down: 0x28,
  Left: 0x25,
  Right: 0x27,
  Insert: 0x2d,
  Home: 0x24,
  End: 0x23,
  PageUp: 0x21,
  PageDown: 0x22,
  Pause: 0x13,
  Scrolllock: 0x91,
  PrintScreen: 0x2c,
  Numlock: 0x90,
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`num${i}`, 0x60 + i])),
  numadd: 0x6b,
  numsub: 0x6d,
  nummult: 0x6a,
  numdiv: 0x6f,
  numdec: 0x6e,
  MediaPlayPause: 0xb3,
  MediaStop: 0xb2,
  MediaNextTrack: 0xb0,
  MediaPreviousTrack: 0xb1,
};

function expectedVk(name: string): number | undefined {
  if (/^[A-Z0-9]$/.test(name)) return name.charCodeAt(0);
  return PICKER_KEY_VK[name];
}

const pickerKeyNames = [...new Set(Object.values(CODE_TO_KEY))];

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

describe.skipIf(!exePath)("windows-key-listener key names", () => {
  test("knows the virtual-key code of every key the picker can save", () => {
    const unmapped = pickerKeyNames.filter((name) => expectedVk(name) === undefined);
    expect(unmapped).toEqual([]);
  });

  // An unrelated key first (0x07 is unassigned), so a listener that fires on
  // anything cannot pass.
  test.concurrent.each(pickerKeyNames)("fires on %s", async (name) => {
    const vk = hex(expectedVk(name) ?? 0);
    const run = await runListener(name, [
      "DOWN 0x07 0",
      "UP 0x07 10",
      `DOWN ${vk} 20`,
      `UP ${vk} 100`,
    ]);

    expect(run.events).toEqual(["KEY_DOWN", "KEY_UP"]);
  });

  test.concurrent.each(pickerKeyNames)("fires on CommandOrControl+%s", async (name) => {
    const vk = hex(expectedVk(name) ?? 0);
    const run = await runListener(`CommandOrControl+${name}`, [
      "DOWN LCTRL 0",
      `DOWN ${vk} 20`,
      `UP ${vk} 100`,
    ]);

    expect(run.events).toEqual(["KEY_DOWN", "KEY_UP"]);
  });

  test.concurrent.each([
    "Bogus",
    "CommandOrControl+Bogus",
    "Mouse3",
    "Ctrl+",
    "A+B",
    "0x0",
    "0x1FF",
  ])("refuses %s: exits 2 without watching anything", async (hotkey) => {
    const run = await runListener(hotkey);

    expect(run.code).toBe(2);
    expect(run.ready).toBe(false);
    expect(run.stderr).toMatch(/^Error: /);
  });

  test("still takes a raw virtual-key code, as Agent Mode sends", async () => {
    const run = await runListener("0xA3", ["DOWN LCTRL 0", "DOWN RCTRL 50", "UP RCTRL 300"]);

    expect(run.events).toEqual(["KEY_DOWN", "KEY_UP"]);
  });
});
