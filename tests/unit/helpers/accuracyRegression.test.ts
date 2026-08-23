import { describe, it, expect } from "vitest";

const {
  compareToBaseline,
  formatComparison,
} = require("../../../scripts/lib/accuracy-regression.js");

// Written before modes existed, so these entries carry no mode. They still
// have to match a pinned measurement, or adding modes would silently
// invalidate every baseline already committed.
const baseline = [
  { language: "en", model: "base", wer: 0.122 },
  { language: "da", model: "base", wer: 0.628 },
];

describe("accuracy regression gate", () => {
  it("passes when results match the baseline", () => {
    const comparison = compareToBaseline(
      [
        { language: "en", model: "base", mode: "pinned", wer: 0.122 },
        { language: "da", model: "base", mode: "pinned", wer: 0.628 },
      ],
      baseline
    );

    expect(comparison.ok).toBe(true);
    expect(comparison.regressions).toEqual([]);
    expect(comparison.unbaselined).toEqual([]);
  });

  it("fails when a language gets worse beyond tolerance", () => {
    const comparison = compareToBaseline(
      [
        { language: "en", model: "base", wer: 0.122 },
        // Danish slipping while English holds steady is the exact shape of
        // the failure that shipped, so it has to be caught.
        { language: "da", model: "base", wer: 0.7 },
      ],
      baseline,
      { tolerancePoints: 1.5 }
    );

    expect(comparison.ok).toBe(false);
    expect(comparison.regressions).toHaveLength(1);
    expect(comparison.regressions[0]).toMatchObject({ language: "da", model: "base" });
    expect(comparison.regressions[0].deltaPoints).toBeCloseTo(7.2, 1);
  });

  it("tolerates small drift so the gate does not cry wolf", () => {
    const comparison = compareToBaseline(
      [
        { language: "en", model: "base", wer: 0.13 },
        { language: "da", model: "base", wer: 0.635 },
      ],
      baseline,
      { tolerancePoints: 1.5 }
    );

    expect(comparison.ok).toBe(true);
  });

  it("treats a disappeared measurement as a failure", () => {
    // A gate that passes because a language stopped being measured would let
    // coverage rot while reporting success.
    const comparison = compareToBaseline([{ language: "en", model: "base", wer: 0.122 }], baseline);

    expect(comparison.ok).toBe(false);
    expect(comparison.missing).toEqual([{ language: "da", model: "base", mode: "pinned" }]);
  });

  it("reports improvements without failing on them", () => {
    const comparison = compareToBaseline(
      [
        { language: "en", model: "base", wer: 0.122 },
        { language: "da", model: "base", wer: 0.4 },
      ],
      baseline
    );

    expect(comparison.ok).toBe(true);
    expect(comparison.improvements).toHaveLength(1);
    expect(formatComparison(comparison).join("\n")).toContain("Refresh the baseline");
  });

  it("surfaces unbaselined pairs instead of pretending they are guarded", () => {
    const comparison = compareToBaseline(
      [
        { language: "en", model: "base", wer: 0.122 },
        { language: "da", model: "base", wer: 0.628 },
        { language: "sv", model: "base", wer: 0.5 },
      ],
      baseline
    );

    expect(comparison.ok).toBe(true);
    expect(comparison.unbaselined).toEqual([
      { language: "sv", model: "base", mode: "pinned", wer: 0.5 },
    ]);
    expect(formatComparison(comparison).join("\n")).toContain("not guarded until baselined");
  });

  it("keys entries by language and model, so order does not matter", () => {
    const comparison = compareToBaseline(
      [
        { language: "da", model: "base", wer: 0.628 },
        { language: "en", model: "base", wer: 0.122 },
      ],
      baseline
    );

    expect(comparison.ok).toBe(true);
  });

  it("does not let one language mask another", () => {
    // Same model id in two languages must stay independent entries.
    const comparison = compareToBaseline(
      [
        { language: "en", model: "base", wer: 0.05 },
        { language: "da", model: "base", wer: 0.9 },
      ],
      baseline
    );

    expect(comparison.ok).toBe(false);
    expect(comparison.regressions.map((entry: { language: string }) => entry.language)).toEqual([
      "da",
    ]);
  });

  // Modes are why the gate can see language detection at all. Pinning the
  // language makes detection irrelevant, so a detection regression is only
  // visible in the constrained mode, and only if the two are kept apart.
  describe("modes", () => {
    const modeBaseline = [
      { language: "da", model: "base", mode: "pinned", wer: 0.628 },
      { language: "da", model: "base", mode: "constrained", wer: 0.645 },
    ];

    it("fails on a constrained regression while pinned holds steady", () => {
      // Exactly what a detection regression looks like: transcription is fine
      // when told the language, and falls apart when it has to work it out.
      const comparison = compareToBaseline(
        [
          { language: "da", model: "base", mode: "pinned", wer: 0.63 },
          { language: "da", model: "base", mode: "constrained", wer: 0.82 },
        ],
        modeBaseline
      );

      expect(comparison.ok).toBe(false);
      expect(comparison.regressions).toHaveLength(1);
      expect(comparison.regressions[0]).toMatchObject({ model: "base", mode: "constrained" });
    });

    it("does not let a good pinned score cover a missing constrained one", () => {
      const comparison = compareToBaseline(
        [{ language: "da", model: "base", mode: "pinned", wer: 0.628 }],
        modeBaseline
      );

      expect(comparison.ok).toBe(false);
      expect(comparison.missing).toEqual([{ language: "da", model: "base", mode: "constrained" }]);
    });

    it("reads a baseline written before modes existed as pinned", () => {
      const comparison = compareToBaseline(
        [{ language: "en", model: "base", mode: "pinned", wer: 0.122 }],
        [{ language: "en", model: "base", wer: 0.122 }]
      );

      expect(comparison.ok).toBe(true);
      expect(comparison.unbaselined).toEqual([]);
    });

    it("names the mode in its output, so a failure says which path broke", () => {
      const comparison = compareToBaseline(
        [{ language: "da", model: "base", mode: "constrained", wer: 0.9 }],
        [{ language: "da", model: "base", mode: "constrained", wer: 0.645 }]
      );

      expect(formatComparison(comparison).join("\n")).toContain("da/base/constrained");
    });
  });
});
