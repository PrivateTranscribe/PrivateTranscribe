import { describe, expect, it } from "vitest";
import { repairSplitDictionaryTerms } from "../../../src/utils/transcriptionTextRepair";

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

  // Danish writes compounds as one word and Whisper splits them apart. These
  // terms are lowercase, so the capital that guards "open code" is never there.
  it("repairs a lowercase compound the user added to the dictionary", () => {
    expect(
      repairSplitDictionaryTerms("Sundarbans har siden 1966 været et vildt reservat.", [
        "vildtreservat",
      ])
    ).toBe("Sundarbans har siden 1966 været et vildtreservat.");

    expect(repairSplitDictionaryTerms("kun mutationer i kim celler", ["kimceller"])).toBe(
      "kun mutationer i kimceller"
    );
  });

  it("still refuses to touch a lowercase phrase when the term is a capitalised name", () => {
    expect(repairSplitDictionaryTerms("vi bruger open code her", ["OpenCode"])).toBe(
      "vi bruger open code her"
    );
  });

  it("leaves a lowercase compound alone when the user has not asked for it", () => {
    expect(repairSplitDictionaryTerms("et vildt reservat i syd", ["kimceller"])).toBe(
      "et vildt reservat i syd"
    );
  });
});
