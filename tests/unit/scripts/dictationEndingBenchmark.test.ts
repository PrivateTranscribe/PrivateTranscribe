import { describe, expect, it } from "vitest";
const {
  scoreCase,
  createWav,
  scalePcm,
} = require("../../../scripts/dictation-ending-benchmark-utils");

const spoken = "I put the banana in my backpack yesterday.";
const short = { reference: spoken, ending: spoken, exact: true };

describe("dictation ending benchmark scoring", () => {
  it("rejects an appended Thank you even when a general WER allowance would hide it", () => {
    expect(scoreCase(short, `${spoken} Thank you.`)).toMatchObject({
      passed: false,
      unexpectedThanks: true,
    });
  });
  it("requires a real quiet thank-you and rejects duplicating it", () => {
    const testCase = { reference: `${spoken} Thank you.`, ending: "Thank you.", exact: true };
    expect(scoreCase(testCase, spoken)).toMatchObject({ passed: false, missingThanks: true });
    expect(scoreCase(testCase, `${spoken} Thank you. Thank you.`).passed).toBe(false);
    expect(scoreCase(testCase, `${spoken} Thank you.`).passed).toBe(true);
  });
  it("rejects arbitrary extra words while ignoring punctuation", () => {
    expect(scoreCase(short, `${spoken} I you`).passed).toBe(false);
    expect(scoreCase(short, spoken.toUpperCase().replace(".", "!")).passed).toBe(true);
  });
  it("fails when the ending is lost even if most earlier words survived", () => {
    const prefix = "One two three four five six seven eight nine ten. ".repeat(20);
    expect(scoreCase({ reference: prefix + spoken, ending: spoken }, prefix).passed).toBe(false);
  });
  it("scales without mutating fixtures or wrapping loud samples", () => {
    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(20000, 0);
    pcm.writeInt16LE(-20000, 2);
    const scaled = scalePcm(pcm, 10);
    expect(scaled.readInt16LE(0)).toBe(32767);
    expect(scaled.readInt16LE(2)).toBe(-32768);
    expect(pcm.readInt16LE(0)).toBe(20000);
    expect(createWav(pcm).subarray(44).equals(pcm)).toBe(true);
  });
});
