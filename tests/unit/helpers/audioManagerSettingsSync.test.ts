import { beforeEach, describe, expect, it, vi } from "vitest";
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

const audioBlob = { type: "audio/webm", size: 1024, arrayBuffer: async () => new ArrayBuffer(8) };

const BROADCAST_KEYS = [
  "useLocalWhisper",
  "preferredLanguage",
  "translateToEnglish",
  "cloudTranscriptionProvider",
  "cloudTranscriptionBaseUrl",
];

/**
 * The dictation overlay is a separate window from the Control Panel. Both read
 * the same localStorage, and some Control Panel changes are also broadcast to
 * the overlay over IPC. The language buttons, the translate toggle and the
 * custom URL field write localStorage without broadcasting, so the overlay has
 * to read localStorage for them, or they only reach dictation after a restart.
 */
describe("AudioManager picks up settings changed while the app runs", () => {
  let broadcast: (settings: Record<string, string | null>) => void;
  let transcribeLocalWhisper: ReturnType<typeof vi.fn>;

  /** What useSettings sends: every current value, not just the one that changed. */
  const broadcastCurrentSettings = () =>
    broadcast(
      Object.fromEntries(BROADCAST_KEYS.map((key) => [key, localStorageMock.getItem(key)]))
    );

  beforeEach(() => {
    (globalThis as any).localStorage = localStorageMock;
    Object.defineProperty(globalThis, "navigator", {
      value: { mediaDevices: null },
      writable: true,
      configurable: true,
    });
    localStorageMock.clear();
    localStorageMock.setItem("useLocalWhisper", "true");
    localStorageMock.setItem("preferredLanguage", "en");
    localStorageMock.setItem("translateToEnglish", "off");
    localStorageMock.setItem("cloudTranscriptionProvider", "custom");
    localStorageMock.setItem("cloudTranscriptionBaseUrl", "https://old.example.com/v1");

    transcribeLocalWhisper = vi.fn().mockResolvedValue({ success: true, text: "hej" });
    (globalThis as any).window = {
      electronAPI: {
        transcribeLocalWhisper,
        onTranscriptionSettingsChanged: (callback: typeof broadcast) => {
          broadcast = callback;
          return () => {};
        },
      },
    };
  });

  it("dictates in a language picked after the first broadcast", async () => {
    const manager: any = new AudioManager();
    broadcastCurrentSettings();

    localStorageMock.setItem("preferredLanguage", "da");
    await manager.processWithLocalWhisper(audioBlob, "base", { skipPostProcessing: true });

    expect(transcribeLocalWhisper.mock.calls[0][1]).toMatchObject({ language: "da" });
  });

  it("translates once translate-to-English is switched on after the first broadcast", async () => {
    localStorageMock.setItem("preferredLanguage", "da");
    const manager: any = new AudioManager();
    broadcastCurrentSettings();

    localStorageMock.setItem("translateToEnglish", "on");
    await manager.processWithLocalWhisper(audioBlob, "base", { skipPostProcessing: true });

    expect(transcribeLocalWhisper.mock.calls[0][1]).toMatchObject({
      language: "da",
      translate: true,
    });
  });

  it("sends cloud dictation to a custom URL changed after the first broadcast", () => {
    const manager: any = new AudioManager();
    broadcastCurrentSettings();
    expect(manager.getTranscriptionEndpoint()).toBe(
      "https://old.example.com/v1/audio/transcriptions"
    );

    localStorageMock.setItem("cloudTranscriptionBaseUrl", "https://new.example.com/v1");

    expect(manager.getTranscriptionEndpoint()).toBe(
      "https://new.example.com/v1/audio/transcriptions"
    );
  });

  it("still uses a broadcast value for a setting localStorage does not hold", () => {
    const manager: any = new AudioManager();

    broadcast({ whisperModel: "small" });

    expect(manager.getTranscriptionSetting("whisperModel", "base")).toBe("small");
  });
});
