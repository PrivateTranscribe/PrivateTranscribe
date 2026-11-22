import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  VoiceCallMeter,
  PauseDetector,
  QUIET_MS,
  MAX_WAIT_MS,
} = require("../../../src/helpers/narrator/voiceCallMeter");

type Reading = { peak: number; sessions: number };

/** windows-audio-meter.exe as the meter sees it: readings on stdout, then an exit. */
function fakeHelper() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: () => void };
    stdin: { end: ReturnType<typeof vi.fn> };
    exitCode: number | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  child.stdin = { end: vi.fn() };
  child.exitCode = null;
  child.kill = vi.fn();
  return {
    child,
    read: (reading: Reading) => child.stdout.emit("data", `${JSON.stringify(reading)}\n`),
  };
}

const TALK = { peak: 0.2, sessions: 1 };
const QUIET = { peak: 0, sessions: 1 };

describe("pause detector", () => {
  it("waits for a whole pause, and talk starts the count again", () => {
    const detector = new PauseDetector();
    expect(detector.add(TALK, 0)).toBeNull();
    expect(detector.add(QUIET, 100)).toBeNull();
    expect(detector.add(QUIET, 600)).toBeNull();
    // A breath between words is not a pause.
    expect(detector.add(TALK, 650)).toBeNull();
    expect(detector.add(QUIET, 700)).toBeNull();
    expect(detector.add(QUIET, 700 + QUIET_MS - 1)).toBeNull();
    expect(detector.add(QUIET, 700 + QUIET_MS)).toBe("pause");
  });

  it("leaves room at once when no voice app plays anything", () => {
    expect(new PauseDetector().add({ peak: 0, sessions: 0 }, 0)).toBe("no-call");
  });

  it("counts a quiet hum on an open microphone as quiet", () => {
    const detector = new PauseDetector();
    detector.add({ peak: 0.004, sessions: 1 }, 0);
    expect(detector.add({ peak: 0.004, sessions: 1 }, QUIET_MS)).toBe("pause");
  });
});

describe("voice call meter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function meterWith(helper: ReturnType<typeof fakeHelper> | null) {
    let now = 0;
    const meter = new VoiceCallMeter({
      spawnMeter: () => helper?.child || null,
      apps: ["discord"],
      now: () => now,
    });
    return { meter, at: (ms: number) => (now = ms) };
  }

  it("speaks in the first pause after the talk, and says how long it waited", async () => {
    vi.useFakeTimers();
    const helper = fakeHelper();
    const { meter, at } = meterWith(helper);
    const call = meter.watch();
    const waiting = call.waitForPause();
    helper.read(TALK);
    at(1500);
    helper.read(TALK);
    at(1600);
    helper.read(QUIET);
    at(1600 + QUIET_MS);
    helper.read(QUIET);
    await expect(waiting).resolves.toEqual({ reason: "pause", waitedMs: 1600 + QUIET_MS });
  });

  it("counts a pause that began before the words were ready", async () => {
    const helper = fakeHelper();
    const { meter, at } = meterWith(helper);
    const call = meter.watch();
    helper.read(QUIET);
    at(QUIET_MS);
    helper.read(QUIET);
    await expect(call.waitForPause()).resolves.toMatchObject({ reason: "pause" });
  });

  it("waits again when the talk came back before the words were ready", async () => {
    vi.useFakeTimers();
    const helper = fakeHelper();
    const { meter, at } = meterWith(helper);
    const call = meter.watch();
    // A whole pause while the words were made, over before they were ready.
    helper.read(QUIET);
    at(QUIET_MS);
    helper.read(QUIET);
    at(QUIET_MS + 100);
    helper.read(TALK);
    let settled = false;
    const waiting = call.waitForPause().then((result: unknown) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);
    at(QUIET_MS + 200);
    helper.read(QUIET);
    at(2 * QUIET_MS + 200);
    helper.read(QUIET);
    await expect(waiting).resolves.toEqual({ reason: "pause", waitedMs: 2 * QUIET_MS + 200 });
  });

  it("speaks anyway once the longest wait is over, so a line is never lost", async () => {
    vi.useFakeTimers();
    const helper = fakeHelper();
    const { meter } = meterWith(helper);
    const waiting = meter.watch().waitForPause();
    helper.read(TALK);
    vi.advanceTimersByTime(MAX_WAIT_MS);
    await expect(waiting).resolves.toMatchObject({ reason: "timeout" });
  });

  it("speaks at once when the meter is missing or dies", async () => {
    await expect(meterWith(null).meter.watch().waitForPause()).resolves.toMatchObject({
      reason: "no-meter",
    });
    const helper = fakeHelper();
    const waiting = meterWith(helper).meter.watch().waitForPause();
    helper.child.emit("exit", 1);
    await expect(waiting).resolves.toMatchObject({ reason: "meter-ended" });
  });

  it("stops waiting when the line is no longer wanted", async () => {
    vi.useFakeTimers();
    let alive = true;
    const helper = fakeHelper();
    const waiting = meterWith(helper)
      .meter.watch()
      .waitForPause({ isAlive: () => alive });
    helper.read(TALK);
    alive = false;
    vi.advanceTimersByTime(250);
    await expect(waiting).resolves.toMatchObject({ reason: "cancelled" });
  });

  it("ends the helper by closing its input, and kills one that hangs", () => {
    vi.useFakeTimers();
    const helper = fakeHelper();
    meterWith(helper).meter.watch().close();
    expect(helper.child.stdin.end).toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(helper.child.kill).toHaveBeenCalled();
  });

  it("skips lines it cannot read", async () => {
    const helper = fakeHelper();
    const { meter, at } = meterWith(helper);
    const call = meter.watch();
    helper.child.stdout.emit("data", 'garbage\n{"peak":0,"sess');
    helper.child.stdout.emit("data", 'ions":1}\n');
    at(QUIET_MS);
    helper.read(QUIET);
    await expect(call.waitForPause()).resolves.toMatchObject({ reason: "pause" });
  });
});
