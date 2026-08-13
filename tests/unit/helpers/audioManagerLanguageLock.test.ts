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

// Auto-detect: the user picked no explicit language, which is the only case
// the lock applies to.
vi.mock("../../../src/utils/languageCompat", () => ({
  resolveTranscriptionLanguage: vi.fn(() => null),
}));

import AudioManager from "../../../src/helpers/audioManager";

const audioBlob = { type: "audio/webm", size: 1024, arrayBuffer: async () => new ArrayBuffer(8) };

describe("AudioManager long-session language lock", () => {
  let transcribeLocalWhisper: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as any).localStorage = localStorageMock;
    Object.defineProperty(globalThis, "navigator", {
      value: { mediaDevices: null },
      writable: true,
      configurable: true,
    });
    localStorageMock.clear();
    localStorageMock.setItem("useLocalWhisper", "true");

    transcribeLocalWhisper = vi.fn().mockResolvedValue({ success: true, text: "goddag" });
    (globalThis as any).window = {
      electronAPI: { transcribeLocalWhisper },
    };
  });

  it("sends no language on the first segment, so whisper still auto-detects", async () => {
    const manager: any = new AudioManager();

    await manager.processWithLocalWhisper(audioBlob, "turbo", {
      source: "long-session",
      skipPostProcessing: true,
      lockedLanguage: null,
    });

    expect(transcribeLocalWhisper.mock.calls[0][1].language).toBeUndefined();
  });

  it("sends the locked language on every later segment", async () => {
    const manager: any = new AudioManager();

    await manager.processWithLocalWhisper(audioBlob, "turbo", {
      source: "long-session",
      skipPostProcessing: true,
      lockedLanguage: "da",
    });

    expect(transcribeLocalWhisper.mock.calls[0][1]).toMatchObject({ language: "da" });
  });

  it("does not start translating just because a language got locked", async () => {
    // translateToEnglish only ever applied to an explicit language choice. A
    // locked auto-detection must not trip it, or Danish speech silently comes
    // back in English.
    localStorageMock.setItem("translateToEnglish", "on");
    const manager: any = new AudioManager();

    await manager.processWithLocalWhisper(audioBlob, "turbo", {
      source: "long-session",
      skipPostProcessing: true,
      lockedLanguage: "da",
    });

    expect(transcribeLocalWhisper.mock.calls[0][1].translate).toBeUndefined();
  });

  it("hands the detected language back so the drain loop can pin it", async () => {
    transcribeLocalWhisper.mockResolvedValue({
      success: true,
      text: "goddag",
      detectedLanguage: "da",
    });
    const manager: any = new AudioManager();

    const result = await manager.processWithLocalWhisper(audioBlob, "turbo", {
      source: "long-session",
      skipPostProcessing: true,
    });

    expect(result).toMatchObject({ text: "goddag", detectedLanguage: "da" });
  });

  it("pins the first detected language across the rest of the queue", async () => {
    const manager: any = new AudioManager();
    const seenLockedLanguages: Array<string | null> = [];

    manager.runTranscription = vi.fn(async (_blob: unknown, metadata: any) => {
      seenLockedLanguages.push(metadata.lockedLanguage ?? null);
      return {
        result: {
          text: `chunk ${metadata.chunkIndex}`,
          // Whisper keeps volunteering an answer; only the first one counts.
          detectedLanguage: metadata.chunkIndex === 0 ? "da" : "no",
        },
      };
    });

    const state = manager.longSession;
    state.active = true;
    state.sessionId = 1;
    state.queue = [0, 1, 2].map((index) => ({
      blob: audioBlob,
      durationMs: 60000,
      index,
      sessionId: 1,
      attempts: 0,
      trimTrailingSilence: false,
    }));

    await manager.drainLongSessionQueue();

    expect(seenLockedLanguages).toEqual([null, "da", "da"]);
    expect(state.detectedLanguage).toBe("da");
  });

  it("forgets the lock between recordings, so switching language still works", async () => {
    const manager: any = new AudioManager();
    manager.longSession.detectedLanguage = "da";

    manager.resetLongSessionState();

    expect(manager.longSession.detectedLanguage).toBeNull();
  });
});
