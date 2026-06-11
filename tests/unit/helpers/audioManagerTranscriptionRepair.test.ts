import { describe, expect, it, vi, beforeEach } from "vitest";
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
  buildWhisperContextHint: vi.fn(() => ""),
  buildFileIdentifierHint: vi.fn(() => ""),
}));

import AudioManager from "../../../src/helpers/audioManager";

describe("AudioManager transcription language repairs", () => {
  beforeEach(() => {
    (globalThis as any).localStorage = localStorageMock;
    Object.defineProperty(globalThis, "navigator", {
      value: { mediaDevices: null },
      writable: true,
      configurable: true,
    });
    localStorageMock.clear();
  });

  it("repairs Danish u de → ude before optional reasoning", async () => {
    localStorageMock.setItem("preferredLanguage", "da");

    const manager = new AudioManager();
    const result = await manager.processTranscription(
      "Jo, jeg har det da ret godt i dag, min ven. Hvorfor er du u de på en gåtur?",
      "local"
    );

    expect(result).toBe(
      "Jo, jeg har det da ret godt i dag, min ven. Hvorfor er du ude på en gåtur?"
    );
  });

  it("does not repair Danish-specific splits when language is auto", async () => {
    localStorageMock.setItem("preferredLanguage", "auto");

    const manager = new AudioManager();
    const result = await manager.processTranscription("Hvorfor er du u de på en gåtur?", "local");

    expect(result).toBe("Hvorfor er du u de på en gåtur?");
  });
});
