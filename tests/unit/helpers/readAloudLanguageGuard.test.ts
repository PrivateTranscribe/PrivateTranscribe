import { describe, expect, test } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkReadAloudLanguage } = require("../../../src/helpers/readAloudLanguageGuard");

/**
 * Ledger gate `readaloud-nonenglish-guard`: Kristian pressed the Read Aloud
 * hotkey on Danish text and got English-phoneme garbage, because the bundled
 * phonemizer only knows English. This guard decides, before synthesis,
 * whether captured text is confidently non-English.
 *
 * The margin and length thresholds are tuned against real tinyld@1.3.4
 * output (see the comments in readAloudLanguageGuard.js for the measured
 * scores) so these are not just "does it not throw" tests - they're the
 * actual samples that shaped the thresholds.
 */
describe("checkReadAloudLanguage", () => {
  test("blocks a real Danish paragraph and names the language", async () => {
    const danish =
      "Det er en dejlig dag i dag, og solen skinner smukt over hele byen. Jeg har lyst til at gå en tur i parken senere.";
    const result = await checkReadAloudLanguage(danish);
    expect(result.block).toBe(true);
    expect(result.languageName).toBe("Danish");
  });

  test("does not block a clean English paragraph", async () => {
    const english =
      "It is a lovely day today, and the sun is shining beautifully over the whole city. I want to take a walk in the park later.";
    const result = await checkReadAloudLanguage(english);
    expect(result.block).toBe(false);
  });

  test("blocks a real German paragraph and names the language", async () => {
    const german =
      "Es ist heute ein wunderschöner Tag, und die Sonne scheint wunderbar über der ganzen Stadt. Ich möchte später im Park spazieren gehen.";
    const result = await checkReadAloudLanguage(german);
    expect(result.block).toBe(true);
    expect(result.languageName).toBe("German");
  });

  test("does not block short Danish - too little text to trust the detector", async () => {
    // 11 characters, far under the 40-char floor. tinyld itself splits this
    // three ways between Danish, Swedish, and Norwegian (da=0.227, sv=0.204,
    // no=0.150) - exactly the kind of coin-flip a length floor exists to
    // avoid acting on.
    const result = await checkReadAloudLanguage("Hej med dig");
    expect(result.block).toBe(false);
  });

  test("does not block text that reads as English despite a couple of loanwords", async () => {
    const mostlyEnglish =
      "I went to the store today and bought some bread, milk, and coffee. Also picked up some hygge candles for the weekend.";
    const result = await checkReadAloudLanguage(mostlyEnglish);
    expect(result.block).toBe(false);
  });

  test("does not block empty or garbage input, and never throws", async () => {
    await expect(checkReadAloudLanguage("")).resolves.toEqual({ block: false });
    await expect(checkReadAloudLanguage(undefined as unknown as string)).resolves.toEqual({
      block: false,
    });
    // Short enough to be caught by the length floor before detection even runs.
    await expect(checkReadAloudLanguage("asdkj 1234 !@#$ zzzz")).resolves.toEqual({
      block: false,
    });
  });
});
