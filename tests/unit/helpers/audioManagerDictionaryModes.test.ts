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

vi.mock("../../../src/utils/languageCompat", () => ({
  resolveTranscriptionLanguage: vi.fn(() => null),
}));

import AudioManager from "../../../src/helpers/audioManager";

describe("AudioManager dictionary entry modes", () => {
  beforeEach(() => {
    (globalThis as any).localStorage = localStorageMock;
    Object.defineProperty(globalThis, "navigator", {
      value: { mediaDevices: null },
      writable: true,
      configurable: true,
    });
    localStorageMock.clear();
  });

  it("turns mixed dictionary modes into explicit Whisper prompt instructions", () => {
    localStorageMock.setItem(
      "customDictionary",
      JSON.stringify(["Synty", "PrivateTranscribe", "OpenCode"])
    );
    localStorageMock.setItem(
      "dictionaryEntryModes",
      JSON.stringify({ Synty: "hint", OpenCode: "priority" })
    );

    const manager = new AudioManager();

    expect(manager.getCustomDictionaryPrompt()).toBe(
      "Vocabulary hints: Synty. Use these exact spellings when they appear: PrivateTranscribe. Priority exact spellings: OpenCode. Prefer these spellings over similar words: OpenCode"
    );
  });

  it("repairs exact and priority entries while leaving hint-only entries alone", () => {
    localStorageMock.setItem(
      "customDictionary",
      JSON.stringify(["Synty", "PrivateTranscribe", "OpenCode"])
    );
    localStorageMock.setItem(
      "dictionaryEntryModes",
      JSON.stringify({ Synty: "hint", OpenCode: "priority" })
    );

    const manager = new AudioManager();

    expect(
      manager.applyDictionaryReplacements(
        "Use synty with Pri vate Trans cribe, opencode, and open code."
      )
    ).toBe("Use synty with PrivateTranscribe, OpenCode, and open code.");
  });

  it("keeps legacy dictionaries exact when no mode map exists", () => {
    localStorageMock.setItem("customDictionary", JSON.stringify(["PrivateTranscribe"]));

    const manager = new AudioManager();

    expect(manager.getCustomDictionaryPrompt()).toBe(
      "Use these exact spellings when they appear: PrivateTranscribe"
    );
    expect(manager.applyDictionaryReplacements("privateTranscribe works")).toBe(
      "PrivateTranscribe works"
    );
  });
});
