import { describe, expect, it } from "vitest";
import {
  repairKnownLanguageSplits,
  repairSplitDictionaryTerms,
} from "../../../src/utils/transcriptionTextRepair";

describe("transcription text repair", () => {
  it("repairs a known dictionary term that STT split with an internal space", () => {
    const text = "Search for options other people are using with OpenC ode and RTX 3090.";

    expect(repairSplitDictionaryTerms(text, ["OpenCode"])).toBe(
      "Search for options other people are using with OpenCode and RTX 3090."
    );
  });

  it("repairs a known dictionary term split across multiple internal spaces", () => {
    expect(
      repairSplitDictionaryTerms("Use Pri vate Trans cribe daily", ["PrivateTranscribe"])
    ).toBe("Use PrivateTranscribe daily");
  });

  it("does not collapse normal lowercase phrases even when a dictionary term matches compactly", () => {
    expect(repairSplitDictionaryTerms("open code is two words", ["OpenCode"])).toBe(
      "open code is two words"
    );
  });

  it("does not rewrite unrelated words without a dictionary term", () => {
    expect(repairSplitDictionaryTerms("OpenC ode is in the transcript", [])).toBe(
      "OpenC ode is in the transcript"
    );
  });

  it("repairs Danish STT splitting the common word ude as u de", () => {
    expect(
      repairKnownLanguageSplits(
        "Jo, jeg har det da ret godt i dag, min ven. Hvorfor er du u de på en gåtur?",
        "da"
      )
    ).toBe("Jo, jeg har det da ret godt i dag, min ven. Hvorfor er du ude på en gåtur?");
  });

  it("does not apply Danish-specific repairs for other languages or auto-detect", () => {
    const text = "Hvorfor er du u de på en gåtur?";

    expect(repairKnownLanguageSplits(text, "en")).toBe(text);
    expect(repairKnownLanguageSplits(text, "auto")).toBe(text);
    expect(repairKnownLanguageSplits(text, null)).toBe(text);
  });
});
