import { beforeEach, describe, expect, it, vi } from "vitest";
import { localStorageMock } from "../../setup";

vi.mock("../../../src/services/ReasoningService", () => ({
  default: {
    processText: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(true),
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
import ReasoningService from "../../../src/services/ReasoningService";

describe("dictation when AI cleanup fails", () => {
  beforeEach(() => {
    (globalThis as any).localStorage = localStorageMock;
    localStorageMock.clear();
    localStorageMock.setItem("useReasoningModel", "true");
    localStorageMock.setItem("reasoningModel", "gpt-5.6-luna");
  });

  it("pastes the raw transcript when cleanup times out", async () => {
    const manager: any = new AudioManager();
    manager._checkBetaFeatureAccess = () => true;
    vi.mocked(ReasoningService.processText).mockRejectedValue(
      new Error("AI cleanup timed out after 21000 ms")
    );

    await expect(manager.processTranscription("This is what I said.", "test")).resolves.toBe(
      "This is what I said."
    );
    expect(ReasoningService.processText).toHaveBeenCalledTimes(1);
  });

  it("marks a long session's transcript, so cleanup gets a longer deadline", async () => {
    const manager: any = new AudioManager();
    manager._checkBetaFeatureAccess = () => true;
    vi.mocked(ReasoningService.processText).mockReset().mockResolvedValue("Cleaned.");

    await manager.processTranscription("A long session.", "long-session");
    await manager.processTranscription("A dictation.", "test");

    const calls = vi.mocked(ReasoningService.processText).mock.calls;
    expect(calls[0][3]).toMatchObject({ longSession: true });
    expect(calls[1][3]).toMatchObject({ longSession: false });
  });
});
