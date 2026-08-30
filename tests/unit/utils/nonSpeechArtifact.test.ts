import { describe, expect, test } from "vitest";
import { classifyNonSpeechArtifact } from "../../../src/utils/nonSpeechArtifact";

const check = (text: string, durationSeconds = 8) =>
  classifyNonSpeechArtifact(text, { durationSeconds });

describe("classifyNonSpeechArtifact, rules that need no corroboration", () => {
  // [Music] and [BANG] were both produced by this repo's own pipeline on
  // non-speech audio, and reach the paste today.
  test.each(["[Music]", "[BANG]", "[BLANK_AUDIO]", "(wind blowing)", "[Applause]"])(
    "drops the annotation %s whatever the recording length",
    (text) => {
      expect(check(text, 1)).toMatchObject({ isArtifact: true, reason: "annotation" });
    }
  );

  test.each([".", "...", "-", "!?"])("drops the wordless transcript %s", (text) => {
    expect(check(text, 1)).toMatchObject({ isArtifact: true, reason: "no-words" });
  });

  test.each([
    "Subtitles by the Amara.org community",
    "Subs by www.zeoranger.co.uk",
    "Transcription by ESO, translated by —",
    "Sous-titres réalisés par la communauté d'Amara.org",
    "Undertekster af Nicolai Winther",
  ])("drops the subtitle credit %s", (text) => {
    expect(check(text, 1)).toMatchObject({ isArtifact: true, reason: "subtitle-credit" });
  });

  test("keeps a real sentence that happens to mention subtitles", () => {
    expect(check("Can you add subtitles by Friday please?")).toMatchObject({ isArtifact: false });
  });

  test("keeps a transcript that merely contains an annotation", () => {
    expect(check("[Music] and then I said hello")).toMatchObject({ isArtifact: false });
  });
});

describe("classifyNonSpeechArtifact, stock phrases", () => {
  test.each(["Thank you.", "thank you", "Thanks for watching!", "You", "Bye.", "Okay"])(
    "drops a lone %s from a recording too long to be one",
    (text) => {
      expect(check(text, 8)).toMatchObject({ isArtifact: true, reason: "stock-phrase" });
    }
  );

  // Dictation here is not English-only.
  test.each(["Tak.", "Mange tak", "Farvel."])("drops a lone Danish %s", (text) => {
    expect(check(text, 8)).toMatchObject({ isArtifact: true, reason: "stock-phrase" });
  });

  test("keeps a short dictation that really is just those words", () => {
    expect(check("Thank you.", 2)).toMatchObject({ isArtifact: false });
    expect(check("Tak.", 3.9)).toMatchObject({ isArtifact: false });
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
    expect(check("Yes", 30)).toMatchObject({ isArtifact: false });
    expect(check("Ja", 30)).toMatchObject({ isArtifact: false });
  });

  test("needs a known duration before dropping a stock phrase", () => {
    expect(classifyNonSpeechArtifact("Thank you.", {})).toMatchObject({ isArtifact: false });
  });

  test("passes empty text through untouched", () => {
    expect(check("")).toMatchObject({ isArtifact: false, reason: null });
  });
});
