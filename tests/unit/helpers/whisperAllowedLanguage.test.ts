import { describe, expect, it, vi, afterEach } from "vitest";
import WhisperServerManager from "../../../src/helpers/whisperServer";
import { resolveAllowedLanguage } from "../../../src/helpers/whisperLanguage";

afterEach(() => {
  vi.restoreAllMocks();
});

const buildManager = () => {
  const manager: any = new WhisperServerManager();
  manager.ready = true;
  manager.process = {};
  manager.canConvert = true;
  manager._scheduleIdleCheck = vi.fn();
  manager._convertToWav = vi.fn().mockResolvedValue(Buffer.from("wav"));
  manager._splitWavIntoTranscriptionChunks = vi
    .fn()
    .mockReturnValue([{ buffer: Buffer.from("chunk-0"), durationSeconds: 20, offsetSeconds: 0 }]);
  return manager;
};

// The shape whisper-server actually returns for verbose_json: its own winner,
// plus the full distribution keyed by ISO code.
const danishHeardAsNorwegian = {
  text: "det virker fint",
  language: "norwegian",
  language_probabilities: { no: 0.52, da: 0.41, sv: 0.05, en: 0.01 },
};

describe("resolveAllowedLanguage", () => {
  it("overrules a neighbour the speaker does not speak", () => {
    expect(resolveAllowedLanguage(danishHeardAsNorwegian, ["da", "en"])).toMatchObject({
      language: "da",
      changed: true,
    });
  });

  it("leaves an already-allowed detection alone, so nothing is re-decoded", () => {
    const result = resolveAllowedLanguage(
      { text: "hello there", language: "english", language_probabilities: { en: 0.98, da: 0.01 } },
      ["da", "en"]
    );
    expect(result).toMatchObject({ language: "en", changed: false });
  });

  it("does not force a language nobody spoke into the transcript", () => {
    // One sentence of German from a Danish/English speaker. Snapping here
    // would turn real words into word salad, so Whisper keeps its answer.
    expect(
      resolveAllowedLanguage(
        { text: "guten tag", language: "german", language_probabilities: { de: 0.95, da: 0.002 } },
        ["da", "en"]
      )
    ).toBeNull();
  });

  it("has nothing to constrain without an allowlist", () => {
    expect(resolveAllowedLanguage(danishHeardAsNorwegian, [])).toBeNull();
    expect(resolveAllowedLanguage(danishHeardAsNorwegian, undefined)).toBeNull();
  });

  it("refuses to decide off silence", () => {
    expect(
      resolveAllowedLanguage({ ...danishHeardAsNorwegian, text: "[BLANK_AUDIO]" }, ["da", "en"])
    ).toBeNull();
  });

  it("still answers when a build omits the probabilities and only one language is possible", () => {
    expect(
      resolveAllowedLanguage({ text: "det virker", language: "norwegian" }, ["da"])
    ).toMatchObject({ language: "da", changed: true });
    expect(
      resolveAllowedLanguage({ text: "det virker", language: "norwegian" }, ["da", "en"])
    ).toBeNull();
  });
});

describe("whisper-server transcription constrained to the spoken languages", () => {
  it("re-decodes in the user's language when detection lands outside their set", async () => {
    const manager = buildManager();
    manager._postInference = vi
      .fn()
      .mockResolvedValueOnce(danishHeardAsNorwegian)
      .mockResolvedValueOnce({ text: "det virker fint", language: "danish" });

    const result = await manager.transcribe(Buffer.from("audio"), {
      allowedLanguages: ["da", "en"],
    });

    expect(manager._postInference).toHaveBeenCalledTimes(2);
    // The first pass has to ask the open question to get a distribution back.
    expect(manager._postInference.mock.calls[0][1]).toMatchObject({
      language: null,
      detectLanguage: true,
    });
    // The second pass is told the answer outright.
    expect(manager._postInference.mock.calls[1][1]).toMatchObject({ language: "da" });
    expect(result.detectedLanguage).toBe("da");
  });

  it("costs nothing when whisper already picked a language the user speaks", async () => {
    const manager = buildManager();
    manager._postInference = vi.fn().mockResolvedValue({
      text: "det virker fint",
      language: "danish",
      language_probabilities: { da: 0.91, no: 0.06 },
    });

    await manager.transcribe(Buffer.from("audio"), { allowedLanguages: ["da", "en"] });

    expect(manager._postInference).toHaveBeenCalledTimes(1);
  });

  it("keeps the first transcript when the corrective pass fails", async () => {
    const manager = buildManager();
    manager._postInference = vi
      .fn()
      .mockResolvedValueOnce(danishHeardAsNorwegian)
      .mockRejectedValueOnce(new Error("whisper-server went away"));

    const result = await manager.transcribe(Buffer.from("audio"), {
      allowedLanguages: ["da", "en"],
    });

    expect(result.text).toBe("det virker fint");
  });

  it("never asks the question when the language was set explicitly", async () => {
    const manager = buildManager();
    manager._postInference = vi.fn().mockResolvedValue({ text: "det virker fint" });

    await manager.transcribe(Buffer.from("audio"), {
      language: "da",
      allowedLanguages: ["da", "en"],
    });

    expect(manager._postInference).toHaveBeenCalledTimes(1);
    expect(manager._postInference.mock.calls[0][1]).toMatchObject({
      language: "da",
      detectLanguage: false,
    });
  });
});
