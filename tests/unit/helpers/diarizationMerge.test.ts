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
    expect(normalizeSpeakerLabel("Speaker 1")).toBe("Speaker 1");
    expect(normalizeSpeakerLabel("speaker 3")).toBe("Speaker 3");
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

  it("keeps text but does not invent speakers when no diarization turns exist", () => {
    const input = [{ start: 0, end: 1, text: "plain" }];
    for (const turns of [[], null]) {
      expect(assignSpeakersToSegments(input, turns)[0]).toMatchObject({
        ...input[0],
        speaker: "Unknown speaker",
      });
    }
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

  it("totals fragmented speech without double-counting overlapping fragments", () => {
    const turns = [
      { start: 0, end: 0.4, speaker: 0 },
      { start: 0.5, end: 1.1, speaker: 1 },
      { start: 1.2, end: 1.6, speaker: 0 },
    ];
    expect(assignSpeakersToSegments([{ start: 0, end: 2, text: "hello" }], turns)[0].speaker).toBe(
      "Speaker 1"
    );
    expect(
      assignSpeakersToSegments(
        [{ start: 0, end: 2, text: "hello" }],
        [turns[0], turns[0], turns[1]]
      )[0].speaker
    ).toBe("Speaker 2");
  });

  it("chooses the nearest voice across a gap, not always the previous voice", () => {
    const result = assignSpeakersToSegments(
      [{ start: 2.8, end: 3, text: "Ja" }],
      [
        { start: 0, end: 2, speaker: 0 },
        { start: 3.1, end: 4, speaker: 1 },
      ]
    );
    expect(result[0].speaker).toBe("Speaker 2");
  });

  it("does not invent a known speaker far from detected speech", () => {
    const result = assignSpeakersToSegments(
      [{ start: 20, end: 21, text: "unmatched" }],
      [{ start: 0, end: 2, speaker: 0 }]
    );
    expect(result[0].speaker).toBe("Unknown speaker");
  });

  it.each([
    [" Danish", " ord", " Ja.", "Danish ord Ja."],
    [" trans", "cription", " yes.", "transcription yes."],
    ["你", "好", "世界", "你好世界"],
  ])(
    "splits timed words across speakers without breaking text: %s",
    (first, second, reply, text) => {
      const result = assignSpeakersToSegments(
        [
          {
            start: 60,
            end: 63,
            text,
            words: [
              { word: first, start: 60, end: 60.5 },
              { word: second, start: 60.5, end: 61 },
              { word: reply, start: 62, end: 63 },
            ],
          },
        ],
        [
          { start: 60, end: 61, speaker: 0 },
          { start: 62, end: 63, speaker: 1 },
        ]
      );
      expect(result.map((s: any) => s.speaker)).toEqual(["Speaker 1", "Speaker 2"]);
      expect(
        result
          .map((s: any) => s.text)
          .join("")
          .trim()
      ).toBe(text);
      expect(result[1].start).toBe(62);
    }
  );

  it("uses segment assignment if word timing is incomplete or does not match the text", () => {
    for (const words of [
      [{ word: "hello", start: -0.01, end: 1 }],
      [{ word: "hello" }],
      [{ word: "wrong", start: 60, end: 61 }],
      [{ word: "hello", start: 0, end: 1 }],
      [null],
    ]) {
      const result = assignSpeakersToSegments(
        [{ start: 60, end: 61, text: "hello", words }],
        [{ start: 60, end: 61, speaker: 1 }]
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ text: "hello", start: 60, end: 61, speaker: "Speaker 2" });
    }
  });

  it("keeps subword tokens in one word even when a boundary falls inside it", () => {
    const result = assignSpeakersToSegments(
      [
        {
          start: 0,
          end: 2,
          text: "transcription",
          words: [
            { word: "trans", start: 0, end: 0.5 },
            { word: "cription", start: 0.5, end: 2 },
          ],
        },
      ],
      [
        { start: 0, end: 0.5, speaker: 0 },
        { start: 0.5, end: 2, speaker: 1 },
      ]
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ text: "transcription", speaker: "Speaker 2" });
  });

  it("uses the segment's speaker for a word in a brief detection gap", () => {
    const result = assignSpeakersToSegments(
      [
        {
          start: 0,
          end: 5,
          text: "This word stays",
          words: [
            { word: "This", start: 0, end: 1 },
            { word: "word", start: 2.4, end: 2.6 },
            { word: "stays", start: 4, end: 5 },
          ],
        },
      ],
      [
        { start: 0, end: 1, speaker: 2 },
        { start: 4, end: 5, speaker: 2 },
      ]
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ text: "This word stays", speaker: "Speaker 3" });
  });
});
