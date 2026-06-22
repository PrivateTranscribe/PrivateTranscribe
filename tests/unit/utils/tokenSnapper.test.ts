import { describe, expect, it } from "vitest";
import { inferCorrectionPairs, snapTranscript } from "../../../src/utils/tokenSnapper";

describe("token correction learning", () => {
  it("learns a single corrected word and preserves target casing", () => {
    expect(inferCorrectionPairs("I spoke to cloud today", "I spoke to Claude today")).toEqual([
      { source: "cloud", target: "Claude" },
    ]);
  });

  it("does not learn a multi-word phrase as an automatic correction", () => {
    expect(inferCorrectionPairs("use login error", "useLoginError")).toEqual([]);
  });

  it("learns a phrase mapping when phrase correction learning is enabled", () => {
    expect(
      inferCorrectionPairs("use login error", "useLoginError", {
        allowPhraseLearning: true,
      })
    ).toEqual([{ source: "use login error", target: "useLoginError" }]);
  });

  it("learns a full sentence rewrite when phrase correction learning is enabled", () => {
    expect(
      inferCorrectionPairs("please write a casual intro", "Hey team, quick update.", {
        allowPhraseLearning: true,
      })
    ).toEqual([{ source: "please write a casual intro", target: "Hey team, quick update." }]);
  });

  it("learns token-level replacements instead of a full sentence rewrite", () => {
    expect(
      inferCorrectionPairs("cloud wrote this in cursor", "Claude wrote this in Cursor")
    ).toEqual([
      { source: "cloud", target: "Claude" },
      { source: "cursor", target: "Cursor" },
    ]);
  });

  it("applies learned word corrections in future transcripts", () => {
    expect(
      snapTranscript({
        transcript: "cloud opened cursor",
        corrections: [
          { source: "cloud", target: "Claude", count: 2 },
          { source: "cursor", target: "Cursor", confirmed: true },
        ],
      })
    ).toBe("Claude opened Cursor");
  });

  it("applies learned phrase corrections before shorter word corrections", () => {
    expect(
      snapTranscript({
        transcript: "please write, a casual intro?",
        corrections: [
          { source: "intro", target: "introduction", count: 2 },
          {
            source: "please write a casual intro",
            target: "Hey team, quick update.",
            count: 2,
          },
        ],
      })
    ).toBe("Hey team, quick update.");
  });
});
