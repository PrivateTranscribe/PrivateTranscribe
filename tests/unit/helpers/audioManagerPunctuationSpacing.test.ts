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

describe("AudioManager punctuation spacing", () => {
  beforeEach(() => {
    (globalThis as any).localStorage = localStorageMock;
    localStorageMock.clear();
  });

  it.each([
    "Add the file to .gitignore today.",
    "We use .NET 8 for the service.",
    "Open the .tsx component.",
  ])("keeps a word that starts with a dot apart from the word before: %j", async (text) => {
    const manager = new AudioManager();

    await expect(manager.processTranscription(text, "local")).resolves.toBe(text);
  });

  it("still closes up a space before ending punctuation", async () => {
    const manager = new AudioManager();

    await expect(manager.processTranscription("Well , that is it .", "local")).resolves.toBe(
      "Well, that is it."
    );
  });
});
