import { describe, expect, test } from "vitest";
import { classifyNonSpeechArtifact } from "../../../src/utils/nonSpeechArtifact";

const check = (text: string, durationSeconds = 8) =>
  classifyNonSpeechArtifact(text, { durationSeconds });

describe("classifyNonSpeechArtifact annotations", () => {
  // All three were produced by this repo's own pipeline on non-speech audio.
  test.each(["[Music]", "[BANG]", "[BLANK_AUDIO]", "(wind blowing)", "[Applause]"])(
    "drops %s whatever the recording length",
    (text) => {
      expect(check(text, 1)).toMatchObject({ isArtifact: true, reason: "annotation" });
    }
  );

  test("keeps a transcript that merely contains an annotation", () => {
    expect(check("[Music] and then I said hello")).toMatchObject({ isArtifact: false });
  });
});

describe("classifyNonSpeechArtifact stock phrases", () => {
  test.each(["Thank you.", "thank you", "Thanks for watching!", "You", "Bye."])(
    "drops a lone %s from a recording too long to be one",
    (text) => {
      expect(check(text, 8)).toMatchObject({ isArtifact: true, reason: "stock-phrase" });
    }
  );

  test("keeps a short dictation that really is just those words", () => {
    expect(check("Thank you.", 2)).toMatchObject({ isArtifact: false });
  });

  test("keeps a stock phrase that is part of a real sentence", () => {
    expect(check("Thank you for sending the report over.", 8)).toMatchObject({
      isArtifact: false,
    });
  });

  test("keeps everything else", () => {
    expect(check("I put the banana in my backpack yesterday.", 8)).toMatchObject({
      isArtifact: false,
    });
  });

  test("needs a known duration before dropping a stock phrase", () => {
    expect(classifyNonSpeechArtifact("Thank you.", {})).toMatchObject({ isArtifact: false });
  });

  test("passes empty text through untouched", () => {
    expect(check("")).toMatchObject({ isArtifact: false, reason: null });
  });
});
