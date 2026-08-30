/**
 * Utility functions for audio device detection and management.
 * Shared between renderer components and audio manager.
 */

/**
 * Determines if a microphone device is a built-in device based on its label.
 * Works across macOS, Windows, and Linux platforms.
 */
export function isBuiltInMicrophone(label: string): boolean {
  const lowerLabel = label.toLowerCase();

  // Direct built-in indicators
  if (
    lowerLabel.includes("built-in") ||
    lowerLabel.includes("internal") ||
    lowerLabel.includes("macbook") ||
    lowerLabel.includes("integrated")
  ) {
    return true;
  }

  // Generic "microphone" without external device indicators
  if (lowerLabel.includes("microphone")) {
    const externalIndicators = [
      "bluetooth",
      "airpods",
      "wireless",
      "usb",
      "external",
      "headset",
      "webcam",
    ];
    return !externalIndicators.some((indicator) => lowerLabel.includes(indicator));
  }

  return false;
}

/**
 * Labels that actually name a built-in device, as opposed to the looser guess
 * `isBuiltInMicrophone` makes for device selection. A USB desk mic and a
 * wireless headset both come through Windows as plain "Microphone (...)", so
 * only these words are worth showing a user as a fact.
 */
export function hasExplicitBuiltInLabel(label: string): boolean {
  const lowerLabel = (label || "").toLowerCase();

  return (
    lowerLabel.includes("built-in") ||
    lowerLabel.includes("internal") ||
    lowerLabel.includes("macbook") ||
    lowerLabel.includes("integrated")
  );
}

/** The two non-device choices the microphone picker offers. */
export const MIC_CHOICE_AUTOMATIC = "automatic";
export const MIC_CHOICE_SYSTEM_DEFAULT = "system-default";

export interface AudioInputDeviceInfo {
  deviceId: string;
  label: string;
}

export interface MicrophonePreference {
  /** Let the app pick, preferring a built-in mic over anything plugged in. */
  preferBuiltInMic: boolean;
  /** An explicit device, used only when `preferBuiltInMic` is off. */
  selectedMicDeviceId: string;
}

/**
 * The device the next dictation will actually open, or null for "whatever the
 * OS calls default".
 *
 * Recording, the picker, the dashboard readout, and the mic test all resolve
 * through here. When they each did their own version, a test could pass on one
 * microphone while dictation recorded silence from another.
 */
export function resolveMicrophoneDeviceId(
  devices: AudioInputDeviceInfo[],
  { preferBuiltInMic, selectedMicDeviceId }: MicrophonePreference
): string | null {
  if (preferBuiltInMic) {
    const builtIn = devices.find((device) => isBuiltInMicrophone(device.label || ""));
    return builtIn ? builtIn.deviceId : null;
  }

  return selectedMicDeviceId || null;
}

/** getUserMedia constraints for the resolved device. */
export function buildMicrophoneConstraints(
  devices: AudioInputDeviceInfo[],
  preference: MicrophonePreference
): MediaStreamConstraints {
  const deviceId = resolveMicrophoneDeviceId(devices, preference);

  return deviceId
    ? { audio: { deviceId: { exact: deviceId }, autoGainControl: true } }
    : { audio: { autoGainControl: true } };
}

/**
 * What to show the user for the current choice. Falls back to a description
 * rather than a device name when the labels are not available yet (before mic
 * permission is granted, enumerateDevices returns blank labels).
 */
export function describeMicrophoneSelection(
  devices: AudioInputDeviceInfo[],
  preference: MicrophonePreference
): string {
  const labelled = devices.filter((device) => device.label);
  const deviceId = resolveMicrophoneDeviceId(labelled, preference);

  if (deviceId) {
    const match = labelled.find((device) => device.deviceId === deviceId);
    if (match) return match.label;
    return preference.preferBuiltInMic ? "Built-in preferred" : "Selected microphone";
  }

  if (preference.preferBuiltInMic) return "Built-in preferred";

  const systemDefault = labelled.find((device) => device.deviceId === "default");
  return systemDefault?.label || "System default";
}
