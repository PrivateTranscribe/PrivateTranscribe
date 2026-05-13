import { describe, expect, it } from "vitest";

const {
  assignSpeakersToSegments,
  normalizeDiarizationSegments,
  normalizeSpeakerLabel,
  overlapSeconds,
} = require("../../../src/helpers/diarizationMerge");

describe("diarizationMerge", () => {
  it("normalizes sherpa speaker ids to human labels", () => {
    expect(normalizeSpeakerLabel("SPEAKER_00")).toBe("Speaker 1");
    expect(normalizeSpeakerLabel("SPEAKER_02")).toBe("Speaker 3");
    expect(normalizeSpeakerLabel(1)).toBe("Speaker 2");
  });

  it("calculates overlap seconds", () => {
    expect(overlapSeconds(0, 2, 1, 3)).toBe(1);
    expect(overlapSeconds(0, 1, 1.1, 2)).toBe(0);
  });

  it("assigns speakers by maximum overlap", () => {
    const whisperSegments = [
      { start: 0, end: 2, text: "hello" },
      { start: 2, end: 4, text: "world" },
    ];
    const diarizationSegments = [
      { start: 0, end: 2.2, speaker: "SPEAKER_00" },
      { start: 2.2, end: 4, speaker: "SPEAKER_01" },
    ];

    const result = assignSpeakersToSegments(whisperSegments, diarizationSegments);

    expect(result[0].speaker).toBe("Speaker 1");
    expect(result[1].speaker).toBe("Speaker 2");
    expect(result[0].text).toBe("hello");
  });

  it("supports 3+ speakers", () => {
    const result = assignSpeakersToSegments(
      [
        { start: 0, end: 1, text: "a" },
        { start: 1, end: 2, text: "b" },
        { start: 2, end: 3, text: "c" },
      ],
      [
        { start: 0, end: 1, speaker: "SPEAKER_00" },
        { start: 1, end: 2, speaker: "SPEAKER_01" },
        { start: 2, end: 3, speaker: "SPEAKER_02" },
      ]
    );

    expect(result.map((segment: any) => segment.speaker)).toEqual([
      "Speaker 1",
      "Speaker 2",
      "Speaker 3",
    ]);
  });

  it("falls back to nearby previous speaker for tiny gaps", () => {
    const result = assignSpeakersToSegments(
      [{ start: 2.05, end: 2.4, text: "gap" }],
      [{ start: 0, end: 2, speaker: "SPEAKER_00" }],
      { nearestGapSeconds: 0.1 }
    );

    expect(result[0].speaker).toBe("Speaker 1");
  });

  it("leaves segments unchanged when no diarization turns exist", () => {
    const input = [{ start: 0, end: 1, text: "plain" }];
    expect(assignSpeakersToSegments(input, [])).toEqual(input);
    expect(assignSpeakersToSegments(input, null)).toEqual(input);
  });

  it("sorts and drops invalid diarization segments", () => {
    expect(
      normalizeDiarizationSegments([
        { start: 5, end: 4, speaker: "bad" },
        { start: 2, end: 3, speaker: "SPEAKER_01" },
        { start: 0, end: 1, speaker: "SPEAKER_00" },
      ])
    ).toEqual([
      { start: 0, end: 1, speaker: "Speaker 1" },
      { start: 2, end: 3, speaker: "Speaker 2" },
    ]);
  });
});
