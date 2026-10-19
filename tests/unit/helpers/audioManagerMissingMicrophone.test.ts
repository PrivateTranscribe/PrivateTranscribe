import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localStorageMock } from "../../setup";

vi.mock("../../../src/services/ReasoningService", () => ({
  default: {
    processText: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(false),
  },
}));

vi.mock("../../../src/helpers/contextPipeline", () => ({
  getContext: vi.fn(),
  isSmartContextEnabled: vi.fn(() => false),
  isFileIdentifiersEnabled: vi.fn(() => false),
  buildWhisperContextHint: vi.fn(),
  buildFileIdentifierHint: vi.fn(),
}));

import AudioManager from "../../../src/helpers/audioManager";

const makeStream = () => ({
  active: true,
  getAudioTracks: () => [
    {
      label: "Microphone Array (Realtek Audio)",
      getSettings: () => ({ deviceId: "default", sampleRate: 48000, channelCount: 1 }),
      stop: vi.fn(),
      readyState: "live",
    },
  ],
  getTracks: () => [{ stop: vi.fn(), readyState: "live" }],
});

class MockMediaRecorder {
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void | Promise<void>) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  start = vi.fn(() => {
    this.state = "recording";
  });
  stop = vi.fn(() => {
    this.state = "inactive";
  });
  requestData = vi.fn();
}

const USB_MIC = { kind: "audioinput", deviceId: "usb-mic-id", label: "Microphone (USB Audio)" };
const SYSTEM_DEVICES = [
  { kind: "audioinput", deviceId: "default", label: "Default - Microphone Array (Realtek Audio)" },
  { kind: "audioinput", deviceId: "built-in-id", label: "Microphone Array (Realtek Audio)" },
  { kind: "audiooutput", deviceId: "speakers-id", label: "Speakers (Realtek Audio)" },
];

const namedError = (name: string) => Object.assign(new Error(""), { name });

/**
 * The microphone picker tells the user that dictation falls back to the system
 * default while their picked microphone is unplugged. These pin that promise to
 * what recording actually does.
 */
describe("AudioManager with the picked microphone unplugged", () => {
  let enumerateDevices: ReturnType<typeof vi.fn>;
  let getUserMedia: ReturnType<typeof vi.fn>;
  let pluggedIn: Set<string>;

  beforeEach(() => {
    localStorageMock.clear();
    (globalThis as any).localStorage = localStorageMock;
    (globalThis as any).MediaRecorder = MockMediaRecorder;
    localStorageMock.setItem("preferBuiltInMic", "false");
    localStorageMock.setItem("selectedMicDeviceId", USB_MIC.deviceId);

    pluggedIn = new Set(["default", "built-in-id"]);
    enumerateDevices = vi.fn().mockResolvedValue(SYSTEM_DEVICES);
    // Windows answers an exact deviceId it cannot find with OverconstrainedError.
    getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      const exact = (constraints.audio as any)?.deviceId?.exact;
      if (exact && !pluggedIn.has(exact)) throw namedError("OverconstrainedError");
      return makeStream();
    });
    Object.defineProperty(globalThis, "navigator", {
      value: {
        mediaDevices: {
          enumerateDevices,
          getUserMedia,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        },
      },
      writable: true,
      configurable: true,
    });
    (globalThis as any).window.electronAPI = {};
  });

  afterEach(() => {
    delete (globalThis as any).window.electronAPI;
  });

  const startRecording = async () => {
    const manager: any = new AudioManager();
    manager.onError = vi.fn();
    const started = await manager.startRecording();
    return { manager, started };
  };

  it("records from the system default instead of failing", async () => {
    const { manager, started } = await startRecording();

    expect(started).toBe(true);
    expect(manager.onError).not.toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia.mock.calls[0][0]).toEqual({ audio: { autoGainControl: true } });
  });

  it("falls back when the device list still shows a microphone that just went", async () => {
    enumerateDevices.mockResolvedValue([...SYSTEM_DEVICES, USB_MIC]);

    const { manager, started } = await startRecording();

    expect(started).toBe(true);
    expect(manager.onError).not.toHaveBeenCalled();
    expect(getUserMedia.mock.calls.map(([constraints]) => constraints)).toEqual([
      { audio: { deviceId: { exact: USB_MIC.deviceId }, autoGainControl: true } },
      { audio: { autoGainControl: true } },
    ]);
  });

  it("keeps recording from the picked microphone while it is plugged in", async () => {
    enumerateDevices.mockResolvedValue([...SYSTEM_DEVICES, USB_MIC]);
    pluggedIn.add(USB_MIC.deviceId);

    const { started } = await startRecording();

    expect(started).toBe(true);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia.mock.calls[0][0]).toEqual({
      audio: { deviceId: { exact: USB_MIC.deviceId }, autoGainControl: true },
    });
  });

  it("says no microphone was found when the default cannot be opened either", async () => {
    enumerateDevices.mockResolvedValue([...SYSTEM_DEVICES, USB_MIC]);
    getUserMedia.mockImplementation(async (constraints: MediaStreamConstraints) => {
      throw namedError(
        (constraints.audio as any)?.deviceId ? "OverconstrainedError" : "NotFoundError"
      );
    });

    const { manager, started } = await startRecording();

    expect(started).toBe(false);
    expect(manager.onError).toHaveBeenCalledWith(
      expect.objectContaining({ title: "No Microphone Found" })
    );
  });

  it("does not retry on the default when access is refused", async () => {
    enumerateDevices.mockResolvedValue([...SYSTEM_DEVICES, USB_MIC]);
    getUserMedia.mockRejectedValue(namedError("NotAllowedError"));

    const { manager, started } = await startRecording();

    expect(started).toBe(false);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(manager.onError).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Microphone Access Denied" })
    );
  });
});
