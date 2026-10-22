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

describe("AudioManager custom dictionary", () => {
  beforeEach(() => {
    (globalThis as any).localStorage = localStorageMock;
    Object.defineProperty(globalThis, "navigator", {
      value: { mediaDevices: null },
      writable: true,
      configurable: true,
    });
    localStorageMock.clear();
  });

  it("sends the dictionary as a bare term list with no instruction filler", () => {
    localStorageMock.setItem(
      "customDictionary",
      JSON.stringify(["Synty", "PrivateTranscribe", "OpenCode"])
    );

    const manager = new AudioManager();

    expect(manager.getCustomDictionaryPrompt()).toBe("Synty, PrivateTranscribe, OpenCode");
  });

  it("returns no prompt when the dictionary is empty", () => {
    localStorageMock.setItem("customDictionary", JSON.stringify([]));

    const manager = new AudioManager();

    expect(manager.getCustomDictionaryPrompt()).toBeNull();
  });

  it("ignores a leftover dictionaryEntryModes key from older versions", () => {
    localStorageMock.setItem("customDictionary", JSON.stringify(["Synty", "OpenCode"]));
    localStorageMock.setItem(
      "dictionaryEntryModes",
      JSON.stringify({ Synty: "hint", OpenCode: "priority" })
    );

    const manager = new AudioManager();

    expect(manager.getCustomDictionaryPrompt()).toBe("Synty, OpenCode");
    // "Synty" was previously mode "hint", which skipped repair. Every term is repaired now.
    expect(manager.applyDictionaryReplacements("Use synty with opencode.")).toBe(
      "Use Synty with OpenCode."
    );
  });

  it("repairs casing and accidental internal splits for every term", () => {
    localStorageMock.setItem(
      "customDictionary",
      JSON.stringify(["Synty", "PrivateTranscribe", "OpenCode"])
    );

    const manager = new AudioManager();

    expect(
      manager.applyDictionaryReplacements(
        "Use synty with Pri vate Trans cribe, opencode, and open code."
      )
    ).toBe("Use Synty with PrivateTranscribe, OpenCode, and open code.");
  });

  it("leaves a genuine mishearing alone, since repair is spelling only", () => {
    localStorageMock.setItem("customDictionary", JSON.stringify(["PrivateTranscribe"]));

    const manager = new AudioManager();

    // Correction Memory handles this case, not the dictionary.
    expect(manager.applyDictionaryReplacements("provoca works")).toBe("provoca works");
  });

  it("does not touch dictionary terms embedded inside a longer word", () => {
    localStorageMock.setItem("customDictionary", JSON.stringify(["Synty"]));

    const manager = new AudioManager();

    expect(manager.applyDictionaryReplacements("syntyphoid is unrelated")).toBe(
      "syntyphoid is unrelated"
    );
  });

  it("repairs terms that start or end with a letter like ø, æ or é", () => {
    // \b only knows ASCII letters, so these were never matched at all.
    localStorageMock.setItem("customDictionary", JSON.stringify(["Østerbro", "Ærø", "Café"]));

    const manager = new AudioManager();

    expect(manager.applyDictionaryReplacements("jeg bor på østerbro, ikke ærø")).toBe(
      "jeg bor på Østerbro, ikke Ærø"
    );
    expect(manager.applyDictionaryReplacements("mød mig på café")).toBe("mød mig på Café");
  });

  it("leaves a term like Øl alone inside a Danish compound", () => {
    localStorageMock.setItem("customDictionary", JSON.stringify(["Øl", "Ål"]));

    const manager = new AudioManager();

    expect(manager.applyDictionaryReplacements("en tuborgøl og sushiål")).toBe(
      "en tuborgøl og sushiål"
    );
  });

  it("repairs terms that start or end with a symbol, such as .NET and C++", () => {
    localStorageMock.setItem("customDictionary", JSON.stringify([".NET", "C++"]));

    const manager = new AudioManager();

    expect(manager.applyDictionaryReplacements("we use .net and c++ code")).toBe(
      "we use .NET and C++ code"
    );
  });

  it("writes a term holding $ as it is stored", () => {
    localStorageMock.setItem("customDictionary", JSON.stringify(["Ca$$h"]));

    const manager = new AudioManager();

    expect(manager.applyDictionaryReplacements("pay with ca$$h")).toBe("pay with Ca$$h");
  });
});
