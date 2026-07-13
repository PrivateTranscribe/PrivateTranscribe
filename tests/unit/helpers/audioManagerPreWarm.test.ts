import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

vi.mock("../../../src/utils/languageCompat", () => ({
  resolveTranscriptionLanguage: vi.fn(() => null),
}));

import AudioManager from "../../../src/helpers/audioManager";

const makeStream = () => ({
  active: true,
  getAudioTracks: () => [
    {
      label: "Test microphone",
      getSettings: () => ({ deviceId: "test-device", sampleRate: 48000, channelCount: 1 }),
      stop: vi.fn(),
      readyState: "live",
    },
  ],
  getTracks: () => [
    {
      stop: vi.fn(),
      readyState: "live",
    },
  ],
});

class MockMediaRecorder {
  state = "inactive";
  mimeType = "audio/webm";
  stream: ReturnType<typeof makeStream>;
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

  constructor(stream: ReturnType<typeof makeStream>) {
    this.stream = stream;
  }
}

describe("AudioManager local transcription pre-warm on recording start", () => {
  let whisperServerStart: ReturnType<typeof vi.fn>;
  let parakeetServerStart: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorageMock.clear();
    (globalThis as any).localStorage = localStorageMock;
    (globalThis as any).MediaRecorder = MockMediaRecorder;
    Object.defineProperty(globalThis, "navigator", {
      value: {
        mediaDevices: {
          enumerateDevices: vi.fn().mockResolvedValue([]),
          getUserMedia: vi.fn().mockResolvedValue(makeStream()),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        },
      },
      writable: true,
      configurable: true,
    });

    whisperServerStart = vi.fn().mockResolvedValue({ success: true });
    parakeetServerStart = vi.fn().mockResolvedValue({ success: true });
    (globalThis as any).window.electronAPI = {
      whisperServerStart,
      parakeetServerStart,
    };
  });

  afterEach(() => {
    delete (globalThis as any).window.electronAPI;
  });

  it("pre-warms the whisper server with the configured model when local whisper is active", async () => {
    localStorageMock.setItem("useLocalWhisper", "true");
    localStorageMock.setItem("localTranscriptionProvider", "whisper");
    localStorageMock.setItem("whisperModel", "turbo");

    const manager = new AudioManager();
    await manager.startRecording();

    expect(whisperServerStart).toHaveBeenCalledWith("turbo");
    expect(parakeetServerStart).not.toHaveBeenCalled();
  });

  it("pre-warms the parakeet server when the nvidia provider is selected", async () => {
    localStorageMock.setItem("useLocalWhisper", "true");
    localStorageMock.setItem("localTranscriptionProvider", "nvidia");
    localStorageMock.setItem("parakeetModel", "parakeet-tdt-0.6b-v3");

    const manager = new AudioManager();
    await manager.startRecording();

    expect(parakeetServerStart).toHaveBeenCalledWith("parakeet-tdt-0.6b-v3");
    expect(whisperServerStart).not.toHaveBeenCalled();
  });

  it("does not pre-warm any local server in cloud transcription mode", async () => {
    localStorageMock.setItem("useLocalWhisper", "false");

    const manager = new AudioManager();
    await manager.startRecording();

    expect(whisperServerStart).not.toHaveBeenCalled();
    expect(parakeetServerStart).not.toHaveBeenCalled();
  });

  it("still starts recording when the pre-warm bridge is unavailable", async () => {
    localStorageMock.setItem("useLocalWhisper", "true");
    delete (globalThis as any).window.electronAPI;

    const manager = new AudioManager();
    const started = await manager.startRecording();

    expect(started).toBe(true);
  });

  it("still starts recording when the pre-warm call rejects", async () => {
    localStorageMock.setItem("useLocalWhisper", "true");
    localStorageMock.setItem("whisperModel", "base");
    whisperServerStart.mockRejectedValue(new Error("server exploded"));

    const manager = new AudioManager();
    const started = await manager.startRecording();

    expect(started).toBe(true);
    expect(whisperServerStart).toHaveBeenCalledWith("base");
  });
});
