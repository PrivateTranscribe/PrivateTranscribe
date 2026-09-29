import { describe, expect, test } from "vitest";
import {
  METER_MAX_SELF_HEALS,
  METER_STALL_MS,
  createMeterStallWatchdog,
} from "../../../src/utils/meterStallWatchdog";

const FRAME_MS = 16;

/** Feed `ms` of meter ticks; returns how many asked for a new context. */
function run(
  watchdog: ReturnType<typeof createMeterStallWatchdog>,
  clock: { now: number; audio: number },
  ms: number,
  { running = true, rendering = true } = {}
) {
  let replacements = 0;
  for (let elapsed = 0; elapsed < ms; elapsed += FRAME_MS) {
    clock.now += FRAME_MS;
    if (running && rendering) clock.audio += FRAME_MS / 1000;
    if (watchdog.shouldReplaceContext({ running, clock: clock.audio, now: clock.now })) {
      replacements += 1;
      // A replacement context starts its own clock.
      clock.audio = 0;
    }
  }
  return replacements;
}

describe("createMeterStallWatchdog", () => {
  test("never replaces a context that keeps rendering, however long the input is silent", () => {
    // The meter's samples are not an input at all: exact digital silence from
    // a muted or fake microphone is what a healthy context renders.
    const clock = { now: 0, audio: 0 };
    const watchdog = createMeterStallWatchdog(clock.now);
    expect(run(watchdog, clock, 60_000)).toBe(0);
  });

  test("replaces a running context whose clock has frozen", () => {
    const clock = { now: 0, audio: 0 };
    const watchdog = createMeterStallWatchdog(clock.now);
    expect(run(watchdog, clock, 2_000)).toBe(0);
    expect(run(watchdog, clock, METER_STALL_MS - 100, { rendering: false })).toBe(0);
    expect(run(watchdog, clock, 200, { rendering: false })).toBe(1);
  });

  test("replaces a context the OS suspended", () => {
    const clock = { now: 0, audio: 0 };
    const watchdog = createMeterStallWatchdog(clock.now);
    expect(run(watchdog, clock, METER_STALL_MS + 100, { running: false })).toBe(1);
  });

  test("gives a replacement its own deadline and stops after repeated failures", () => {
    const clock = { now: 0, audio: 0 };
    const watchdog = createMeterStallWatchdog(clock.now);
    const replacements = run(watchdog, clock, 60_000, { running: false });
    expect(replacements).toBe(METER_MAX_SELF_HEALS);
    expect(watchdog.heals).toBe(METER_MAX_SELF_HEALS);
  });

  test("starts counting failures again once a replacement renders", () => {
    const clock = { now: 0, audio: 0 };
    const watchdog = createMeterStallWatchdog(clock.now);
    expect(run(watchdog, clock, METER_STALL_MS + 100, { running: false })).toBe(1);
    expect(run(watchdog, clock, 1_000)).toBe(0);
    expect(watchdog.heals).toBe(0);
    expect(run(watchdog, clock, 60_000, { running: false })).toBe(METER_MAX_SELF_HEALS);
  });
});
