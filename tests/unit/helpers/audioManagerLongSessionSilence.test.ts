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

const audioBlob = { type: "audio/webm", size: 1024, arrayBuffer: async () => new ArrayBuffer(8) };
const longSessionChunk = { source: "long-session", skipPostProcessing: true };

// A long dictation is sent in segments of about a minute. A segment the
// speaker was silent through is a normal outcome and adds nothing; a segment
// that failed is retried and, if it stays failed, marked as a gap.
describe("AudioManager long-session silence on local Whisper", () => {
  let transcribeLocalWhisper: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as any).localStorage = localStorageMock;
    localStorageMock.clear();
    localStorageMock.setItem("useLocalWhisper", "true");
    transcribeLocalWhisper = vi.fn();
    (globalThis as any).window = { electronAPI: { transcribeLocalWhisper } };
  });

  it.each([
    { name: "an empty success", reply: { success: true, text: "" } },
    { name: "no audio detected", reply: { success: false, message: "No audio detected" } },
    {
      name: "an empty audio buffer",
      reply: { success: false, error: "no_audio_data", message: "No audio detected" },
    },
  ])("counts $name as a silent segment", async ({ reply }) => {
    transcribeLocalWhisper.mockResolvedValue(reply);
    const manager: any = new AudioManager();

    const result = await manager.processWithLocalWhisper(audioBlob, "base", longSessionChunk);

    expect(result).toMatchObject({ success: true, text: "" });
  });

  it.each([
    {
      name: "a failed audio conversion",
      reply: {
        success: false,
        error: "ffmpeg_error",
        message: "Audio conversion failed. The recording may be corrupted.",
      },
    },
    {
      name: "a missing Whisper binary",
      reply: {
        success: false,
        error: "whisper_not_found",
        message: "Whisper binary is missing. Please reinstall the app.",
      },
    },
    {
      name: "a missing model",
      reply: { success: false, error: "model_not_found", message: "Model base not downloaded" },
    },
  ])("fails the segment on $name instead of dropping it as silence", async ({ reply }) => {
    transcribeLocalWhisper.mockResolvedValue(reply);
    const manager: any = new AudioManager();

    await expect(
      manager.processWithLocalWhisper(audioBlob, "base", longSessionChunk)
    ).rejects.toThrow(reply.message);
  });
});
