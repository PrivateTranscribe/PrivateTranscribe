import { describe, expect, it } from "vitest";
import {
  buildDictionaryPrompt,
  getDictionaryEntryMode,
  getDictionaryRepairTerms,
  parseDictionaryEntryModes,
  pruneDictionaryEntryModes,
} from "../../../src/utils/dictionaryEntryModes";

describe("dictionary entry modes", () => {
  it("defaults existing dictionary entries to exact repair behavior", () => {
    expect(getDictionaryEntryMode({}, "PrivateTranscribe")).toBe("exact");
    expect(getDictionaryRepairTerms(["PrivateTranscribe"], {})).toEqual(["PrivateTranscribe"]);
  });

  it("keeps hint-only entries out of local repair", () => {
    const modes = { Synty: "hint" as const, PrivateTranscribe: "priority" as const };

    expect(getDictionaryRepairTerms(["Synty", "PrivateTranscribe"], modes)).toEqual([
      "PrivateTranscribe",
    ]);
  });

  it("builds explicit prompt groups for hint, exact, and priority entries", () => {
    expect(
      buildDictionaryPrompt(["Synty", "PrivateTranscribe", "OpenCode"], {
        Synty: "hint",
        OpenCode: "priority",
      })
    ).toBe(
      "Vocabulary hints: Synty. Use these exact spellings when they appear: PrivateTranscribe. Priority exact spellings: OpenCode. Prefer these spellings over similar words: OpenCode"
    );
  });

  it("ignores invalid stored modes and prunes removed words", () => {
    const modes = parseDictionaryEntryModes(
      JSON.stringify({ Keep: "priority", Drop: "exact", Bad: "force" })
    );

    expect(pruneDictionaryEntryModes(modes, ["Keep"])).toEqual({ Keep: "priority" });
  });
});
