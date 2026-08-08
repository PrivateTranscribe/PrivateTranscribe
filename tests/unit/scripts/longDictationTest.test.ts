import { describe, expect, it } from "vitest";

const {
  buildBoundaryChecks,
  scoreLongDictation,
} = require("../../../scripts/long-dictation-test-utils");
const { buildElectronArguments } = require("../../../scripts/long-dictation-test");

describe("long dictation transcript scoring", () => {
  it("accepts a transcript that preserves the late-session boundary passages", () => {
    const manifest = {
      referenceText:
        "A clear opening establishes the subject. The five minute boundary remains intact. The final sentence closes the recording naturally.",
      boundaryChecks: [
        {
          label: "five-minute",
          text: "The five minute boundary remains intact.",
        },
        {
          label: "ending",
          text: "The final sentence closes the recording naturally.",
        },
      ],
    };

    const result = scoreLongDictation(manifest, manifest.referenceText);

    expect(result.passed).toBe(true);
    expect(result.wordErrorRate).toBe(0);
    expect(result.missingBoundaries).toEqual([]);
  });

  it("fails when the five-minute passage is missing even if the ending remains", () => {
    const manifest = {
      referenceText:
        "A clear opening establishes the subject. The five minute boundary remains intact. The final sentence closes the recording naturally.",
      boundaryChecks: [
        {
          label: "five-minute",
          text: "The five minute boundary remains intact.",
        },
        {
          label: "ending",
          text: "The final sentence closes the recording naturally.",
        },
      ],
    };

    const result = scoreLongDictation(
      manifest,
      "A clear opening establishes the subject. The final sentence closes the recording naturally."
    );

    expect(result.passed).toBe(false);
    expect(result.missingBoundaries).toEqual(["five-minute"]);
  });

  it("fails a hallucinated repeated-word ending", () => {
    const manifest = {
      referenceText: "We can use the language model until a certain point.",
      boundaryChecks: [],
    };

    const result = scoreLongDictation(
      manifest,
      "We can use the language model until a certain point. Yeah. Yeah. Yeah. Yeah. Yeah. Yeah."
    );

    expect(result.passed).toBe(false);
    expect(result.repeatedTail).toEqual({ phrase: "yeah", repetitions: 6 });
  });

  it("fails when Whisper duplicates a long passage inside the transcript", () => {
    const passage = "the night was clear starlit and splendid after the storm passed away";
    const manifest = {
      referenceText: `${passage} everyone returned safely`,
      boundaryChecks: [],
    };

    const result = scoreLongDictation(manifest, `${passage} ${passage} everyone returned safely`);

    expect(result.passed).toBe(false);
    expect(result.repeatedPassage).toEqual({ phrase: passage, wordCount: 12 });
  });

  it("fails when Whisper invents words after the known final passage", () => {
    const ending = "the story came back and I wondered whether it was true";
    const manifest = {
      referenceText: `an ordinary opening ${ending}`,
      boundaryChecks: [{ label: "ending", text: ending }],
    };

    const result = scoreLongDictation(manifest, `an ordinary opening ${ending} I was not alone`);

    expect(result.passed).toBe(false);
    expect(result.unexpectedTail).toEqual({ text: "i was not alone", wordCount: 4 });
  });

  it("builds checks from speech around five minutes and the real ending", () => {
    const clips = [
      { startSeconds: 0, endSeconds: 290, text: "opening material" },
      { startSeconds: 290, endSeconds: 304, text: "words crossing five minutes" },
      { startSeconds: 304, endSeconds: 318, text: "words just after five minutes" },
      { startSeconds: 370, endSeconds: 382, text: "penultimate ending passage" },
      { startSeconds: 382, endSeconds: 390, text: "final ending passage" },
    ];

    expect(buildBoundaryChecks(clips)).toEqual([
      {
        label: "five-minute",
        targetSeconds: 300,
        text: "words crossing five minutes words just after five minutes",
      },
      {
        label: "ending",
        targetSeconds: 382,
        text: "penultimate ending passage final ending passage",
      },
    ]);
  });

  it("does not treat the same boundary words in the wrong order as a match", () => {
    const manifest = {
      referenceText: "alpha bravo charlie delta echo foxtrot",
      boundaryChecks: [
        {
          label: "five-minute",
          text: "alpha bravo charlie delta echo foxtrot",
        },
      ],
    };

    const result = scoreLongDictation(manifest, "foxtrot echo delta charlie bravo alpha");

    expect(result.missingBoundaries).toEqual(["five-minute"]);
  });

  it("launches Electron with one-shot fake microphone audio", () => {
    expect(buildElectronArguments("C:\\fixture.wav", "C:\\app")).toEqual([
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--use-file-for-fake-audio-capture=C:\\fixture.wav%noloop",
      "C:\\app",
    ]);
  });
});
