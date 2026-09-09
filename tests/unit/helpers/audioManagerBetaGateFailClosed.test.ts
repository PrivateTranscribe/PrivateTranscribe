import { describe, it, expect, vi, beforeEach } from "vitest";
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

vi.mock("../../../src/utils/languageCompat", () => ({
  resolveTranscriptionLanguage: vi.fn(() => null),
}));

import AudioManager from "../../../src/helpers/audioManager";
import ReasoningService from "../../../src/services/ReasoningService";

/**
 * The entitlement check is wired in from the renderer, so the failure mode
 * worth testing is not "a Free user flipped the toggle" — it is the check
 * going missing. A beta workflow that runs whenever nobody wired the gate is
 * a beta workflow that ships to everyone the first time that wiring moves.
 */
describe("beta feature gates fail closed", () => {
  it("does not enhance coding shortcuts twice, then restores ordinary cleanup", async () => {
    const manager: any = new AudioManager();
    manager._checkBetaFeatureAccess = () => true;
    localStorageMock.setItem("useReasoningModel", "true");
    manager.codingPromptSession = true;
    await expect(manager.isReasoningAvailable()).resolves.toBe(false);
    manager.codingPromptSession = false;
    await expect(manager.isReasoningAvailable()).resolves.toBe(true);
  });
  it("checks availability again when the connection changes", async () => {
    const manager: any = new AudioManager();
    manager._checkBetaFeatureAccess = () => true;
    localStorageMock.setItem("useReasoningModel", "true");
    localStorageMock.setItem("reasoningModel", "qwen3-4b");
    vi.mocked(ReasoningService.isAvailable)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await expect(manager.isReasoningAvailable()).resolves.toBe(true);
    localStorageMock.setItem("reasoningModel", "claude-code");
    await expect(manager.isReasoningAvailable()).resolves.toBe(false);
  });
  beforeEach(() => {
    (globalThis as any).localStorage = localStorageMock;
    localStorageMock.clear();
    (globalThis.window as any).electronAPI = {
      getCorrectionMemory: vi.fn().mockResolvedValue([{ target: "Claude", confirmed: 1 }]),
    };
    (globalThis as any).electronAPI = (globalThis.window as any).electronAPI;
  });

  it("starts with no access rather than assuming access", async () => {
    const manager: any = new AudioManager();

    // The constructor default decides what happens if the renderer never
    // wires the check. Null denies; an accidental `true` would ship every
    // beta workflow to everyone.
    expect(manager._checkBetaFeatureAccess).toBeNull();
  });

  it("reports AI enhancement unavailable when no access check is wired", async () => {
    const manager: any = new AudioManager();
    localStorageMock.setItem("useReasoningModel", "true");

    await expect(manager.isReasoningAvailable()).resolves.toBe(false);
  });

  it("reports AI enhancement unavailable when the check denies it", async () => {
    const manager: any = new AudioManager();
    manager._checkBetaFeatureAccess = vi.fn().mockReturnValue(false);
    localStorageMock.setItem("useReasoningModel", "true");

    await expect(manager.isReasoningAvailable()).resolves.toBe(false);
    expect(manager._checkBetaFeatureAccess).toHaveBeenCalledWith("ai-enhancement");
  });
});
