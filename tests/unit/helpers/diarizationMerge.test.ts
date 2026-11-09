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
    [" Danish", " ord.", " Ja.", "Danish ord. Ja."],
    [" trans", "cription.", " yes.", "transcription. yes."],
    ["你", "好。", "世界", "你好。世界"],
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

  // Whisper base on tests/fixtures/multispeaker/interview.wav, as the app
  // decoded it, with the speaker models' turns from the same run. Whisper
  // times a sentence's last word late, past the end of its speaker's turn.
  const words = (list: [string, number, number][]) =>
    list.map(([word, start, end]) => ({ word, start, end }));
  const interviewSegments = [
    {
      start: 58.64,
      end: 61.92,
      text: " How accurate is it with a strong accent?",
      words: words([
        [" How", 58.92, 58.92],
        [" accurate", 58.93, 59.66],
        [" is", 59.66, 59.83],
        [" it", 59.87, 59.99],
        [" with", 60.06, 60.39],
        [" a", 60.39, 60.44],
        [" strong", 60.49, 60.81],
        [" accent", 61.6, 61.6],
        ["?", 61.92, 61.92],
      ]),
    },
    {
      start: 61.92,
      end: 65.52,
      text: " Better than I expected, though it still trips over names.",
      words: words([
        [" Better", 62.21, 62.33],
        [" than", 62.39, 62.63],
        [" I", 62.63, 62.7],
        [" expected", 62.7, 63.24],
        [",", 63.27, 63.44],
        [" though", 63.44, 63.9],
        [" it", 63.9, 64.02],
        [" still", 64.07, 64.1],
        [" trips", 64.81, 64.81],
        [" over", 64.81, 65.11],
        [" names", 65.45, 65.52],
        [".", 65.52, 65.52],
      ]),
    },
    {
      start: 65.52,
      end: 69.12,
      text: " I keep a list of terms from my field.",
      words: words([
        [" I", 65.63, 65.63],
        [" keep", 65.81, 66.09],
        [" a", 66.09, 66.11],
        [" list", 66.22, 66.62],
        [" of", 66.66, 66.87],
        [" terms", 66.94, 67.32],
        [" from", 67.47, 67.69],
        [" my", 68.16, 68.16],
        [" field", 68.74, 68.74],
        [".", 69.05, 69.12],
      ]),
    },
  ];
  const interviewTurns = [
    { start: 59.03, end: 60.85, speaker: 0 },
    { start: 62.16, end: 65.03, speaker: 1 },
    { start: 65.71, end: 67.78, speaker: 1 },
    { start: 69.4, end: 70.47, speaker: 2 },
  ];

  it("keeps a sentence's late last word with the speaker who said the sentence", () => {
    const result = assignSpeakersToSegments(interviewSegments, interviewTurns);
    expect(result.map((s: any) => [s.speaker, s.text.trim()])).toEqual([
      ["Speaker 1", "How accurate is it with a strong accent?"],
      ["Speaker 2", "Better than I expected, though it still trips over names."],
      ["Speaker 2", "I keep a list of terms from my field."],
    ]);
    // Each line still starts at its first word.
    expect(result.map((s: any) => s.start)).toEqual([58.92, 62.21, 65.63]);
  });

  it("gives a sentence's early first words to the speaker who said most of it", () => {
    // The same run at 74-82 s. The speaker models put the host's first four
    // words in the previous speaker's turn, and "do?" falls nearer the next.
    const result = assignSpeakersToSegments(
      [
        {
          start: 74.39,
          end: 75.36,
          text: " settled down.",
          words: words([
            [" settled", 74.39, 74.44],
            [" down", 74.45, 74.95],
            [".", 74.95, 75.36],
          ]),
        },
        {
          start: 75.36,
          end: 78.96,
          text: " Is there anything you would still like it to do?",
          words: words([
            [" Is", 75.53, 75.53],
            [" there", 75.65, 75.95],
            [" anything", 76.06, 76.66],
            [" you", 76.66, 76.92],
            [" would", 76.92, 77.35],
            [" still", 77.35, 77.53],
            [" like", 78.13, 78.13],
            [" it", 78.13, 78.3],
            [" to", 78.3, 78.47],
            [" do", 78.64, 78.64],
            ["?", 78.89, 78.96],
          ]),
        },
        {
          start: 78.96,
          end: 81.68,
          text: " I would like it to tell me who was speaking.",
          words: words([
            [" I", 79.04, 79.04],
            [" would", 79.25, 79.37],
            [" like", 79.43, 79.74],
            [" it", 79.74, 79.9],
            [" to", 79.9, 80.05],
            [" tell", 80.06, 80.31],
            [" me", 80.38, 80.53],
            [" who", 80.53, 80.76],
            [" was", 80.91, 81.01],
            [" speaking", 81.01, 81.14],
            [".", 81.68, 81.68],
          ]),
        },
      ],
      [
        { start: 71.06, end: 74.11, speaker: 2 },
        { start: 75.58, end: 77.03, speaker: 2 },
        { start: 77.03, end: 77.67, speaker: 0 },
        { start: 79.22, end: 81.28, speaker: 1 },
      ]
    );
    expect(result.map((s: any) => [s.speaker, s.text.trim(), s.start])).toEqual([
      ["Speaker 3", "settled down.", 74.39],
      ["Speaker 1", "Is there anything you would still like it to do?", 75.53],
      ["Speaker 2", "I would like it to tell me who was speaking.", 79.04],
    ]);
  });

  // One word a second from 0 s, each word's speaker set by its own turn.
  const spoken = (pieces: [string, number][]) => {
    const text = pieces.map(([word]) => ` ${word}`).join("");
    return {
      segments: [
        {
          start: 0,
          end: pieces.length,
          text,
          words: pieces.map(([word], i) => ({ word: ` ${word}`, start: i, end: i + 1 })),
        },
      ],
      turns: pieces.map(([, speaker], i) => ({ start: i, end: i + 1, speaker })),
    };
  };
  const speakersOf = (result: any[]) => result.map((s: any) => [s.speaker, s.text.trim()]);

  it("leaves a sentence split when no one speaker said most of it", () => {
    // Two words each: no speaker has the most.
    const tie = spoken([
      ["We", 0],
      ["could", 0],
      ["meet", 1],
      ["Monday.", 1],
    ]);
    expect(speakersOf(assignSpeakersToSegments(tie.segments, tie.turns))).toEqual([
      ["Speaker 1", "We could"],
      ["Speaker 2", "meet Monday."],
    ]);
    // The most is two of five words, under half.
    const scattered = spoken([
      ["We", 0],
      ["could", 0],
      ["meet", 1],
      ["on", 2],
      ["Monday.", 3],
    ]);
    expect(
      assignSpeakersToSegments(scattered.segments, scattered.turns).map((s: any) => s.speaker)
    ).toEqual(["Speaker 1", "Speaker 2", "Speaker 3", "Speaker 4"]);
  });

  it("leaves a run of more than 50 words without a sentence end as it is", () => {
    const long = spoken([
      ...Array.from({ length: 49 }, (_, i): [string, number] => [`word${i}`, 0]),
      ["and", 1],
      ["done.", 1],
    ]);
    expect(assignSpeakersToSegments(long.segments, long.turns).map((s: any) => s.speaker)).toEqual([
      "Speaker 1",
      "Speaker 2",
    ]);
    const fifty = spoken([
      ...Array.from({ length: 48 }, (_, i): [string, number] => [`word${i}`, 0]),
      ["and", 1],
      ["done.", 1],
    ]);
    expect(
      assignSpeakersToSegments(fifty.segments, fifty.turns).map((s: any) => s.speaker)
    ).toEqual(["Speaker 1"]);
  });

  it("does not move words across a segment without word times", () => {
    const result = assignSpeakersToSegments(
      [
        {
          start: 0,
          end: 3,
          text: " So we keep",
          words: words([
            [" So", 0, 1],
            [" we", 1, 2],
            [" keep", 2, 3],
          ]),
        },
        { start: 3, end: 4, text: " it" },
        {
          start: 4,
          end: 5,
          text: " short.",
          words: words([[" short.", 4, 5]]),
        },
      ],
      [
        { start: 0, end: 3, speaker: 0 },
        { start: 3, end: 5, speaker: 1 },
      ]
    );
    expect(speakersOf(result)).toEqual([
      ["Speaker 1", "So we keep"],
      ["Speaker 2", "it"],
      ["Speaker 2", "short."],
    ]);
  });
});
