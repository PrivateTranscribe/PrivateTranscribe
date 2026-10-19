import { describe, expect, it } from "vitest";
import {
  buildMicrophoneConstraints,
  describeMicrophoneSelection,
  isMissingMicrophoneError,
  isSelectedMicrophoneMissing,
  resolveMicrophoneDeviceId,
} from "../../../src/utils/audioDeviceUtils";

const DEVICES = [
  { deviceId: "default", label: "Default - Headset Microphone (Jabra)" },
  { deviceId: "built-in-id", label: "Microphone Array (Realtek Audio)" },
  { deviceId: "headset-id", label: "Headset Microphone (Jabra Evolve)" },
];

/**
 * Recording, the picker, the mic test, and the dashboard readout all resolve
 * through these. If they disagree, a passing mic test can sit next to a
 * dictation that records silence from another device - the exact failure this
 * shared resolver exists to prevent.
 */
describe("resolveMicrophoneDeviceId", () => {
  it("picks the built-in device when automatic is on", () => {
    expect(
      resolveMicrophoneDeviceId(DEVICES, { preferBuiltInMic: true, selectedMicDeviceId: "" })
    ).toBe("built-in-id");
  });

  it("ignores an explicit device while automatic is on", () => {
    expect(
      resolveMicrophoneDeviceId(DEVICES, {
        preferBuiltInMic: true,
        selectedMicDeviceId: "headset-id",
      })
    ).toBe("built-in-id");
  });

  it("falls back to the system default when no built-in exists", () => {
    const externalOnly = [{ deviceId: "headset-id", label: "Headset Microphone (Jabra Evolve)" }];

    expect(
      resolveMicrophoneDeviceId(externalOnly, { preferBuiltInMic: true, selectedMicDeviceId: "" })
    ).toBeNull();
  });

  it("uses the explicitly picked device when automatic is off", () => {
    expect(
      resolveMicrophoneDeviceId(DEVICES, {
        preferBuiltInMic: false,
        selectedMicDeviceId: "headset-id",
      })
    ).toBe("headset-id");
  });

  it("uses the system default when automatic is off and nothing is picked", () => {
    expect(
      resolveMicrophoneDeviceId(DEVICES, { preferBuiltInMic: false, selectedMicDeviceId: "" })
    ).toBeNull();
  });

  it("uses the system default while the picked device is unplugged", () => {
    expect(
      resolveMicrophoneDeviceId(DEVICES, {
        preferBuiltInMic: false,
        selectedMicDeviceId: "unplugged-id",
      })
    ).toBeNull();
  });

  it("keeps the pick while the list hides device names", () => {
    // Before mic permission, the list proves nothing about what is plugged in.
    const unlabelled = [{ deviceId: "", label: "" }];

    expect(
      resolveMicrophoneDeviceId(unlabelled, {
        preferBuiltInMic: false,
        selectedMicDeviceId: "headset-id",
      })
    ).toBe("headset-id");
  });
});

describe("isSelectedMicrophoneMissing", () => {
  it("is true only for a picked device the labelled list does not show", () => {
    const pick = (selectedMicDeviceId: string) => ({
      preferBuiltInMic: false,
      selectedMicDeviceId,
    });

    expect(isSelectedMicrophoneMissing(DEVICES, pick("unplugged-id"))).toBe(true);
    expect(isSelectedMicrophoneMissing(DEVICES, pick("headset-id"))).toBe(false);
    expect(isSelectedMicrophoneMissing(DEVICES, pick(""))).toBe(false);
    expect(isSelectedMicrophoneMissing([{ deviceId: "", label: "" }], pick("headset-id"))).toBe(
      false
    );
    expect(
      isSelectedMicrophoneMissing(DEVICES, { preferBuiltInMic: true, selectedMicDeviceId: "x" })
    ).toBe(false);
  });
});

describe("isMissingMicrophoneError", () => {
  it("matches the errors getUserMedia gives for a device that is not there", () => {
    const named = (name: string) => Object.assign(new Error(""), { name });

    expect(isMissingMicrophoneError(named("OverconstrainedError"))).toBe(true);
    expect(isMissingMicrophoneError(named("NotFoundError"))).toBe(true);
    expect(isMissingMicrophoneError(named("NotAllowedError"))).toBe(false);
    expect(isMissingMicrophoneError(named("NotReadableError"))).toBe(false);
    expect(isMissingMicrophoneError(null)).toBe(false);
  });
});

describe("buildMicrophoneConstraints", () => {
  it("pins the resolved device exactly", () => {
    expect(
      buildMicrophoneConstraints(DEVICES, {
        preferBuiltInMic: false,
        selectedMicDeviceId: "headset-id",
      })
    ).toEqual({ audio: { deviceId: { exact: "headset-id" }, autoGainControl: true } });
  });

  it("leaves the device unconstrained when it resolves to the system default", () => {
    expect(
      buildMicrophoneConstraints(DEVICES, { preferBuiltInMic: false, selectedMicDeviceId: "" })
    ).toEqual({ audio: { autoGainControl: true } });
  });

  it("does not ask for an unplugged device by its exact id", () => {
    // An exact id Windows cannot find fails the whole recording.
    expect(
      buildMicrophoneConstraints(DEVICES, {
        preferBuiltInMic: false,
        selectedMicDeviceId: "unplugged-id",
      })
    ).toEqual({ audio: { autoGainControl: true } });
  });
});

describe("describeMicrophoneSelection", () => {
  it("names the built-in device automatic resolved to", () => {
    expect(
      describeMicrophoneSelection(DEVICES, { preferBuiltInMic: true, selectedMicDeviceId: "" })
    ).toBe("Microphone Array (Realtek Audio)");
  });

  it("names the picked device", () => {
    expect(
      describeMicrophoneSelection(DEVICES, {
        preferBuiltInMic: false,
        selectedMicDeviceId: "headset-id",
      })
    ).toBe("Headset Microphone (Jabra Evolve)");
  });

  it("names the system default an unplugged pick falls back to", () => {
    expect(
      describeMicrophoneSelection(DEVICES, {
        preferBuiltInMic: false,
        selectedMicDeviceId: "unplugged-id",
      })
    ).toBe("Default - Headset Microphone (Jabra)");
  });

  it("describes a pick it cannot check yet rather than naming another device", () => {
    const unlabelled = [{ deviceId: "", label: "" }];

    expect(
      describeMicrophoneSelection(unlabelled, {
        preferBuiltInMic: false,
        selectedMicDeviceId: "unplugged-id",
      })
    ).toBe("Selected microphone");
  });

  it("falls back to a description before labels are readable", () => {
    const unlabelled = [{ deviceId: "built-in-id", label: "" }];

    expect(
      describeMicrophoneSelection(unlabelled, { preferBuiltInMic: true, selectedMicDeviceId: "" })
    ).toBe("Built-in preferred");
  });
});
