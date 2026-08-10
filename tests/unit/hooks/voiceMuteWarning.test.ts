import { describe, expect, test } from "vitest";
import { shouldWarnAboutFailedMute } from "../../../src/hooks/useAudioRecording";

/**
 * The mute is best effort, so most of its outcomes are unremarkable and must
 * stay silent. The one that is not: the app saw a live call, tried to mute it,
 * and failed. Warning too eagerly here trains people to dismiss the toast,
 * which is how the important one gets ignored.
 */
describe("shouldWarnAboutFailedMute", () => {
  test("a successful mute says nothing", () => {
    expect(shouldWarnAboutFailedMute({ muted: true, reason: "held" })).toBe(false);
  });

  test("not being in a call is not a failure", () => {
    // The common case by far. A toast here would appear on most dictations.
    expect(shouldWarnAboutFailedMute({ muted: false, reason: "no-call" })).toBe(false);
  });

  test("an unconfigured key is not a failure", () => {
    expect(shouldWarnAboutFailedMute({ muted: false, reason: "no-key" })).toBe(false);
  });

  test("warns when a live call could not be muted", () => {
    expect(shouldWarnAboutFailedMute({ muted: false, reason: "hold-failed" })).toBe(true);
    expect(shouldWarnAboutFailedMute({ muted: false, reason: "error" })).toBe(true);
  });

  test("says nothing when the IPC call returned nothing at all", () => {
    // An old preload without the channel resolves undefined. That is a missing
    // feature, not a call broadcasting a dictation.
    expect(shouldWarnAboutFailedMute(undefined)).toBe(false);
    expect(shouldWarnAboutFailedMute(null)).toBe(false);
  });
});
