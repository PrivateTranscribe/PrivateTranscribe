import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

/**
 * The hold and release timing of the voice-call mute, against a fake helper.
 * Nothing here spawns windows-hold-key.exe or presses a key: the fake records
 * what the real helper would do with its stdin.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { VoiceMuter } = require("../../../src/helpers/voiceMuter");

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
  stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  private lines: string[] = [];
  private stdinClosed = false;
  stdin = Object.assign(new EventEmitter(), {
    write: (text: string) => {
      if (this.exitCode !== null) throw new Error("EPIPE");
      this.lines.push(...text.split("\n").filter(Boolean));
      this.drain();
      return true;
    },
    end: () => {
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
    if (this.exitCode !== null) return;
    this.killed = true;
    this.exit(1);
  }

  private drain() {
    if (!this.pressed || this.ignoreRelease || this.exitCode !== null) return;
    if (this.lines.includes("release") || this.stdinClosed) {
      this.pressed = false;
      this.exit(0);
    }
  }

  private exit(code: number) {
    this.exitCode = code;
    setImmediate(() => this.emit("close", code));
  }
}

function makeMuter() {
  const helpers: FakeHelper[] = [];
  const muter = new VoiceMuter({
    spawn: (_exe: string, args: string[]) => {
      const helper = new FakeHelper(args);
      helpers.push(helper);
      return helper;
    },
    resolveExecutable: () => "C:\\fake\\windows-hold-key.exe",
    heldTimeoutMs: 200,
    releaseTimeoutMs: 200,
  });
  muter.isSupported = true;
  return { muter, helpers };
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
