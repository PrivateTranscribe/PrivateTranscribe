import { describe, expect, it } from "vitest";
import {
  CORRECTION_REJECTION_REASONS,
  explainCorrectionRejection,
  inferCorrectionPairs,
  snapTranscript,
} from "../../../src/utils/tokenSnapper";

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

  it("applies only explicitly confirmed corrections in future transcripts", () => {
    expect(
      snapTranscript({
        transcript: "cloud opened cursor",
        corrections: [
          { source: "cloud", target: "Claude", count: 2 },
          { source: "cursor", target: "Cursor", confirmed: true },
        ],
      })
    ).toBe("cloud opened Cursor");
  });

  it("reports no rejection reason when a correction is learnable", () => {
    expect(explainCorrectionRejection("I spoke to cloud today", "I spoke to Claude today")).toBeNull();
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
            confirmed: true,
          },
        ],
      })
    ).toBe("Hey team, quick update.");
  });
});

describe("correction rejection reasons", () => {
  // "word1 word2 ... wordN-1 <last>" - a cheap way to sit either side of the 30-token cap.
  const words = (count: number, last: string) =>
    Array.from({ length: count - 1 }, (_, i) => `word${i + 1}`)
      .concat(last)
      .join(" ");

  type Case = {
    name: string;
    inserted: string;
    corrected: string;
    options?: { allowPhraseLearning?: boolean };
    reason: string | null;
  };

  const cases: Case[] = [
    // --- learnable: reason must be null ---
    {
      name: "single word fix",
      inserted: "I spoke to cloud today",
      corrected: "I spoke to Claude today",
      reason: null,
    },
    {
      name: "two word fixes in one edit",
      inserted: "cloud wrote this in cursor",
      corrected: "Claude wrote this in Cursor",
      reason: null,
    },
    {
      name: "overlap exactly at the 50% boundary",
      inserted: "alpha beta gamma delta",
      corrected: "alpha beta zulu yankee",
      reason: null,
    },
    {
      name: "exactly 30 tokens, one changed",
      inserted: words(30, "delta"),
      corrected: words(30, "zulu"),
      reason: null,
    },
    {
      name: "phrase learning on, glued identifier",
      inserted: "use login error",
      corrected: "useLoginError",
      options: { allowPhraseLearning: true },
      reason: null,
    },

    // --- token-count-changed: the near-miss the UI must explain ---
    {
      name: "glued identifier in word mode",
      inserted: "use login error",
      corrected: "useLoginError",
      reason: CORRECTION_REJECTION_REASONS.TOKEN_COUNT_CHANGED,
    },
    {
      name: "one word added",
      inserted: "call me at noon",
      corrected: "call me at noon today",
      reason: CORRECTION_REJECTION_REASONS.TOKEN_COUNT_CHANGED,
    },
    {
      name: "one word dropped",
      inserted: "call me at noon",
      corrected: "call me noon",
      reason: CORRECTION_REJECTION_REASONS.TOKEN_COUNT_CHANGED,
    },
    {
      name: "removal ratio just under the mass-deletion cutoff",
      inserted: "one two three four five",
      corrected: "one two six",
      reason: CORRECTION_REJECTION_REASONS.TOKEN_COUNT_CHANGED,
    },

    // --- mostly-deleted ---
    {
      name: "removal ratio exactly at the 60% cutoff",
      inserted: "one two three four five",
      corrected: "one two",
      reason: CORRECTION_REJECTION_REASONS.MOSTLY_DELETED,
    },
    {
      name: "field cleared down to a single word",
      inserted: "please send the report before friday",
      corrected: "ok",
      reason: CORRECTION_REJECTION_REASONS.MOSTLY_DELETED,
    },

    // --- too-different ---
    {
      name: "overlap just under the 50% boundary",
      inserted: "alpha beta gamma delta",
      corrected: "alpha zulu yankee xray",
      reason: CORRECTION_REJECTION_REASONS.TOO_DIFFERENT,
    },
    {
      name: "unrelated clipboard copy",
      inserted: "alpha beta gamma delta",
      corrected: "totally unrelated clipboard text",
      reason: CORRECTION_REJECTION_REASONS.TOO_DIFFERENT,
    },

    // --- too-long ---
    {
      name: "31 tokens, one changed",
      inserted: words(31, "delta"),
      corrected: words(31, "zulu"),
      reason: CORRECTION_REJECTION_REASONS.TOO_LONG,
    },

    // --- no-change ---
    {
      name: "identical text",
      inserted: "hello world",
      corrected: "hello world",
      reason: CORRECTION_REJECTION_REASONS.NO_CHANGE,
    },
    {
      name: "cleared clipboard",
      inserted: "hello world",
      corrected: "   ",
      reason: CORRECTION_REJECTION_REASONS.NO_CHANGE,
    },
    {
      name: "nothing was inserted",
      inserted: "",
      corrected: "hello world",
      reason: CORRECTION_REJECTION_REASONS.NO_CHANGE,
    },
    {
      name: "phrase learning on, identical text",
      inserted: "hello world",
      corrected: "hello world",
      options: { allowPhraseLearning: true },
      reason: CORRECTION_REJECTION_REASONS.NO_CHANGE,
    },

    // --- no-learnable-span ---
    {
      name: "phrase learning on, past the span token limit",
      inserted: words(200, "alpha"),
      corrected: words(200, "beta"),
      options: { allowPhraseLearning: true },
      reason: CORRECTION_REJECTION_REASONS.NO_LEARNABLE_SPAN,
    },
  ];

  const knownReasons = Object.values(CORRECTION_REJECTION_REASONS);

  for (const testCase of cases) {
    it(`reports ${testCase.reason ?? "no rejection"} for ${testCase.name}`, () => {
      expect(
        explainCorrectionRejection(testCase.inserted, testCase.corrected, testCase.options)
      ).toBe(testCase.reason);
    });
  }

  it("never disagrees with inferCorrectionPairs", () => {
    for (const testCase of cases) {
      const pairs = inferCorrectionPairs(testCase.inserted, testCase.corrected, testCase.options);
      const reason = explainCorrectionRejection(
        testCase.inserted,
        testCase.corrected,
        testCase.options
      );

      // The property the toast depends on: a reason exists exactly when nothing was learned.
      expect(reason === null, `${testCase.name}: reason ${reason} vs ${pairs.length} pairs`).toBe(
        pairs.length > 0
      );
      if (reason !== null) {
        expect(knownReasons, `${testCase.name}: unknown reason ${reason}`).toContain(reason);
      }
    }
  });
});
