import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The hold and release timing of the voice-call mute, against a fake helper.
 * Nothing here spawns windows-hold-key.exe or presses a key: the fake records
 * what the real helper would do with its stdin.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { VoiceMuter, HELD_MARKER_FILE_NAME } = require("../../../src/helpers/voiceMuter");

/**
 * Behaves like windows-hold-key.exe: the key goes down, "held" is printed,
 * and only then is stdin read. A "release" line, or stdin closing, lets go
 * and exits 0. A kill exits without letting go, like TerminateProcess.
 */
class FakeHelper extends EventEmitter {
  pressed = false;
  everPressed = false;
  killed = false;
  exitCode: number | null = null;
  ignoreRelease = false;
  /** How long letting go takes, like a helper slow to exit. */
  exitDelayMs = 0;
  private exiting = false;
  stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  private lines: string[] = [];
  private stdinClosed = false;
  stdin = Object.assign(new EventEmitter(), {
    writableEnded: false,
    write: (text: string) => {
      if (this.exitCode !== null) throw new Error("EPIPE");
      this.lines.push(...text.split("\n").filter(Boolean));
      this.drain();
      return true;
    },
    end: () => {
      this.stdin.writableEnded = true;
      this.stdinClosed = true;
      this.drain();
    },
  });

  constructor(public args: string[]) {
    super();
  }

  /** The helper finished starting: press and announce it. */
  printHeld() {
    this.pressed = true;
    this.everPressed = true;
    this.stdout.emit("data", "held\r\n");
    this.drain();
  }

  kill() {
    if (this.exitCode !== null || this.killed) return;
    this.killed = true;
    // Node reports a killed child with no exit code.
    this.exitCode = -1;
    setImmediate(() => this.emit("close", null));
  }

  private drain() {
    if (!this.pressed || this.ignoreRelease || this.exitCode !== null || this.exiting) return;
    if (this.lines.includes("release") || this.stdinClosed) {
      this.pressed = false;
      this.exit(0);
    }
  }

  /** The helper dies on its own, without its key-up. */
  crash() {
    this.exit(1);
  }

  private exit(code: number | null) {
    if (this.exitDelayMs > 0) {
      this.exiting = true;
      setTimeout(() => {
        this.exitCode = code;
        this.emit("close", code);
      }, this.exitDelayMs);
      return;
    }
    this.exitCode = code;
    setImmediate(() => this.emit("close", code));
  }
}

/** --release-only: sends the key-up for --key and exits 0. */
class FakeReleaseOnly extends EventEmitter {
  constructor(public key: string) {
    super();
    setImmediate(() => this.emit("close", 0));
  }
}

function makeMuter(userDataPath?: string) {
  const helpers: FakeHelper[] = [];
  const keyUps: string[] = [];
  const muter = new VoiceMuter({
    spawn: (_exe: string, args: string[]) => {
      if (args.includes("--release-only")) {
        const key = args.find((arg) => arg.startsWith("--key="))!.slice(6);
        keyUps.push(key);
        return new FakeReleaseOnly(key);
      }
      const helper = new FakeHelper(args);
      helpers.push(helper);
      return helper;
    },
    resolveExecutable: () => "C:\\fake\\windows-hold-key.exe",
    heldTimeoutMs: 200,
    releaseTimeoutMs: 200,
  });
  muter.isSupported = true;
  if (userDataPath) muter.configure({ userDataPath });
  return { muter, helpers, keyUps };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("an ordinary dictation", () => {
  it("holds the key until release, then lets go", async () => {
    const { muter, helpers } = makeMuter();
    const holding = muter.hold("F13");
    helpers[0].printHeld();
    await expect(holding).resolves.toBe(true);
    expect(muter.isMuted()).toBe(true);

    await expect(muter.release()).resolves.toBe(true);
    expect(helpers[0].pressed).toBe(false);
    expect(helpers[0].killed).toBe(false);
    expect(muter.isMuted()).toBe(false);
  });
});

describe("a quick tap", () => {
  it("still lets go when the release comes before the helper is up", async () => {
    const { muter, helpers } = makeMuter();
    const holding = muter.hold("F13");
    await tick();

    // The dictation is over before the helper printed "held".
    const releasing = muter.release();
    helpers[0].printHeld();

    // True, or the overlay would warn that the call heard the dictation.
    await expect(holding).resolves.toBe(true);
    await expect(releasing).resolves.toBe(true);
    expect(helpers[0].everPressed).toBe(true);
    expect(helpers[0].pressed).toBe(false);
    expect(helpers[0].killed).toBe(false);
    expect(muter.isMuted()).toBe(false);
  });

  it("does not start a second helper for a hold that is still starting", async () => {
    const { muter, helpers } = makeMuter();
    const first = muter.hold("F13");
    const second = muter.hold("F13");
    helpers[0].printHeld();

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(helpers).toHaveLength(1);
    await muter.release();
  });
});

describe("a helper that ends without its key-up", () => {
  it("sends the key-up after a kill instead of leaving the key down", async () => {
    const { muter, helpers, keyUps } = makeMuter();
    const holding = muter.hold("Ctrl+Shift+M");
    helpers[0].printHeld();
    await holding;

    helpers[0].ignoreRelease = true;
    await muter.release();

    expect(helpers[0].killed).toBe(true);
    expect(keyUps).toEqual(["Ctrl+Shift+M"]);
  });

  it("asks a helper that never confirmed to let go before killing it", async () => {
    const { muter, helpers, keyUps } = makeMuter();
    const holding = muter.hold("F13");
    await tick();
    // Pressed late, after the hold gave up waiting.
    setTimeout(() => helpers[0].printHeld(), 250);

    await expect(holding).resolves.toBe(false);
    expect(helpers[0].everPressed).toBe(true);
    expect(helpers[0].pressed).toBe(false);
    expect(helpers[0].killed).toBe(false);
    expect(keyUps).toEqual([]);
  });

  it("sends the key-up when the helper crashes mid-hold", async () => {
    const { muter, helpers, keyUps } = makeMuter();
    const holding = muter.hold("F13");
    helpers[0].printHeld();
    await holding;

    helpers[0].crash();
    await tick();
    await tick();

    expect(muter.isMuted()).toBe(false);
    expect(keyUps).toEqual(["F13"]);
  });
});

describe("the held-key marker", () => {
  let userData: string;
  let marker: string;

  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), "pt-voice-mute-"));
    marker = path.join(userData, HELD_MARKER_FILE_NAME);
  });

  afterEach(() => {
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it("is on disk while the key is held and gone after a clean release", async () => {
    const { muter, helpers } = makeMuter(userData);
    const holding = muter.hold("F13");
    expect(JSON.parse(fs.readFileSync(marker, "utf8")).key).toBe("F13");

    helpers[0].printHeld();
    await holding;
    expect(fs.existsSync(marker)).toBe(true);

    await muter.release();
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("lets the next start release the key a killed run left down", async () => {
    // The last run's helper was killed outright, so its marker survived.
    const lastRun = makeMuter(userData);
    const holding = lastRun.muter.hold("Ctrl+Shift+M");
    lastRun.helpers[0].printHeld();
    await holding;
    expect(fs.existsSync(marker)).toBe(true);

    const nextStart = makeMuter(userData);
    await expect(nextStart.muter.recoverStuckKey()).resolves.toBe(true);
    expect(nextStart.keyUps).toEqual(["Ctrl+Shift+M"]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("deletes an unreadable marker instead of tripping over it every start", async () => {
    fs.writeFileSync(marker, "{not json");
    const { muter, keyUps } = makeMuter(userData);
    await expect(muter.recoverStuckKey()).resolves.toBe(false);
    expect(keyUps).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("does nothing at startup when the last run ended cleanly", async () => {
    const { muter, keyUps } = makeMuter(userData);
    await expect(muter.recoverStuckKey()).resolves.toBe(false);
    expect(keyUps).toEqual([]);
  });
});

async function waitForHelpers(helpers: FakeHelper[], count: number) {
  for (let i = 0; i < 50 && helpers.length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(helpers).toHaveLength(count);
}

describe("a new dictation right after Escape", () => {
  it("gets its own press instead of riding on a hold that is letting go", async () => {
    const { muter, helpers } = makeMuter();
    // Start, then Escape while the first helper is still starting.
    const first = muter.hold("F13");
    await tick();
    const releasing = muter.release();
    // Start again before the first helper printed "held".
    const second = muter.hold("F13");
    helpers[0].printHeld();
    await expect(first).resolves.toBe(true);
    await releasing;

    await waitForHelpers(helpers, 2);
    helpers[1].printHeld();
    await expect(second).resolves.toBe(true);
    expect(muter.isMuted()).toBe(true);
    expect(helpers[0].pressed).toBe(false);
    expect(helpers[1].pressed).toBe(true);
    await muter.release();
  });

  it("does not press again until the last helper has let go", async () => {
    const { muter, helpers } = makeMuter();
    const first = muter.hold("F13");
    helpers[0].printHeld();
    await first;

    helpers[0].exitDelayMs = 30;
    const releasing = muter.release();
    const second = muter.hold("F13");
    await waitForHelpers(helpers, 2);
    // The first helper had exited before the second one was started.
    expect(helpers[0].exitCode).toBe(0);
    helpers[1].printHeld();
    await releasing;
    await expect(second).resolves.toBe(true);
    expect(muter.isMuted()).toBe(true);
    await muter.release();
  });
});

describe("a forced key-up for an old helper", () => {
  it("is skipped when a newer dictation holds the same key", async () => {
    const { muter, helpers, keyUps } = makeMuter();
    // The first helper hangs: it never confirms and ignores its release.
    const first = muter.hold("F13");
    await tick();
    helpers[0].ignoreRelease = true;

    // It gives up on the first helper after 200 ms, then waits 200 ms more
    // for it to exit before the kill. The next dictation starts in between.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const second = muter.hold("F13");
    await waitForHelpers(helpers, 2);
    helpers[1].printHeld();
    await expect(second).resolves.toBe(true);

    await expect(first).resolves.toBe(false);
    expect(helpers[0].killed).toBe(true);
    expect(keyUps).toEqual([]);
    expect(muter.isMuted()).toBe(true);
    expect(helpers[1].pressed).toBe(true);
    await muter.release();
  });
});
