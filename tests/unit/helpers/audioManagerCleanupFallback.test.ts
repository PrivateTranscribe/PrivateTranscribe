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

  describe("the notice when cleanup is skipped", () => {
    const setup = () => {
      const manager: any = new AudioManager();
      manager._checkBetaFeatureAccess = () => true;
      const onNotice = vi.fn();
      manager.setCallbacks({ onNotice });
      return { manager, onNotice };
    };

    beforeEach(() => {
      vi.mocked(ReasoningService.isAvailable).mockReset().mockResolvedValue(true);
      vi.mocked(ReasoningService.processText).mockReset();
    });

    it("keeps the raw text and says why, once per kind of failure", async () => {
      const { manager, onNotice } = setup();
      vi.mocked(ReasoningService.processText).mockRejectedValue(
        Object.assign(new Error("Incorrect API key provided"), { status: 401 })
      );

      await expect(manager.processTranscription("What I said.", "test")).resolves.toBe(
        "What I said."
      );
      await manager.processTranscription("More.", "test");

      expect(onNotice).toHaveBeenCalledTimes(1);
      expect(onNotice).toHaveBeenCalledWith({
        title: "AI cleanup skipped",
        description: "OpenAI refused the API key. Check it in AI Enhancement.",
      });

      // Another kind of failure is a new reason, so it is told too.
      vi.mocked(ReasoningService.processText).mockRejectedValue(new TypeError("Failed to fetch"));
      await manager.processTranscription("Offline now.", "test");
      await manager.processTranscription("Still offline.", "test");
      expect(onNotice).toHaveBeenCalledTimes(2);
      expect(onNotice.mock.calls[1][0].description).toBe(
        "Could not reach OpenAI. Check your connection."
      );
    });

    it("tells a failure again after a cleanup that worked", async () => {
      const { manager, onNotice } = setup();
      vi.mocked(ReasoningService.processText)
        .mockRejectedValueOnce(new Error("OpenAI request timed out after 21000 ms"))
        .mockResolvedValueOnce("Cleaned.")
        .mockRejectedValueOnce(new Error("OpenAI request timed out after 21000 ms"));

      await manager.processTranscription("One.", "test");
      await manager.processTranscription("Two.", "test");
      await manager.processTranscription("Three.", "test");

      expect(onNotice).toHaveBeenCalledTimes(2);
    });

    it("says the selected provider has no key when cleanup is on without one", async () => {
      const { manager, onNotice } = setup();
      localStorageMock.setItem("reasoningProvider", "anthropic");
      localStorageMock.setItem("reasoningModel", "claude-sonnet-5");
      vi.mocked(ReasoningService.isAvailable).mockResolvedValue(false);

      await expect(manager.processTranscription("Raw words.", "test")).resolves.toBe("Raw words.");

      expect(ReasoningService.processText).not.toHaveBeenCalled();
      expect(onNotice).toHaveBeenCalledWith({
        title: "AI cleanup skipped",
        description: "Anthropic has no API key. Add one in AI Enhancement.",
      });
    });

    it("stays quiet when AI cleanup is switched off", async () => {
      const { manager, onNotice } = setup();
      localStorageMock.setItem("useReasoningModel", "false");

      await manager.processTranscription("Raw words.", "test");

      expect(onNotice).not.toHaveBeenCalled();
    });

    it("stays quiet when the user cancelled the cleanup", async () => {
      const { manager, onNotice } = setup();
      vi.mocked(ReasoningService.processText).mockRejectedValue(new Error("AI cleanup cancelled"));

      await manager.processTranscription("Raw words.", "test");

      expect(onNotice).not.toHaveBeenCalled();
    });
  });
});
