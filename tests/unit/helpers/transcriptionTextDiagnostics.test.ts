import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const readAudioManager = () =>
  fs.readFileSync(path.join(process.cwd(), "src", "helpers", "audioManager.js"), "utf8");

describe("transcription text diagnostics", () => {
  it("keeps transcript text logging behind an explicit localStorage opt-in", () => {
    const contents = readAudioManager();

    expect(contents).toContain("debugTranscriptionText");
    expect(contents).toContain("isTranscriptionTextDebugEnabled");
    expect(contents).toContain("if (!isTranscriptionTextDebugEnabled()) return;");
    expect(contents).toContain("console.info(`[transcription-text] ${stage}`");
    expect(contents).toContain('logger.info(`TRANSCRIPTION_TEXT_${stage}`');
  });

  it("traces raw, normalized, and final transcription stages for root-cause debugging", () => {
    const contents = readAudioManager();

    expect(contents).toContain('emitTranscriptionTextTrace("PIPELINE"');
    expect(contents).toContain('raw: rawInputText');
    expect(contents).toContain('normalized: normalizedText');
    expect(contents).toContain('dictionaryChanged: withDictionary !== rawInputText');
    expect(contents).toContain('punctuationChanged: normalizedText !== withDictionary');
    expect(contents).toContain('emitTranscriptionTextTrace("FINAL"');
    expect(contents).toContain("reasoningUsed");
  });
});
