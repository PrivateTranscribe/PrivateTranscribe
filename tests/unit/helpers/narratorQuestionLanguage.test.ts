import { describe, expect, it } from "vitest";
import { questionLanguage } from "../../../src/helpers/narrator/voiceAnswers";

describe("questionLanguage", () => {
  it.each([
    // One Danish name does not flip an English question.
    [
      "Which should Main take up next, the lease or the Talentværk board? The lease The board",
      "da",
      "en",
    ],
    // Clearly Danish words overrule an English setting.
    ["Skal jeg køre testen igen nu? Ja Nej", "en", "da"],
    // Clearly English words overrule a Danish setting.
    ["Should I merge it now? Merge it Not now", "da", "en"],
    // Too few words to tell: the setting decides.
    ["Merge Søren's PR? Merge Wait", "en", "en"],
    ["Run tests? Run Skip", "da", "da"],
  ])("%s (setting %s) -> %s", (text, setting, expected) => {
    expect(questionLanguage(text, setting)).toBe(expected);
  });
});
