import { describe, expect, it } from "vitest";
import { formatTranscript } from "../../../src/helpers/transcriptFormatter";

const sample = {
  segments: [
    { start: 0, end: 1.5, text: "Hello there" },
    { start: 1.5, end: 3, text: "[SPEAKER_TURN] Hi back" },
    { start: 3, end: 4, text: "How are you?" },
  ],
};

describe("transcriptFormatter", () => {
  it("formats speaker turns as plain text", () => {
    const result = formatTranscript(sample, "plain");
    expect(result.speakerCount).toBe(2);
    expect(result.speakers).toEqual(["Speaker 1", "Speaker 2"]);
    expect(result.text).toContain("Speaker 1: Hello there");
    expect(result.text).toContain("Speaker 2: Hi back How are you?");
    expect(result.text).not.toContain("SPEAKER_TURN");
  });

  it("does not leave spaces before punctuation when punctuation is split into a segment", () => {
    const result = formatTranscript(
      {
        segments: [
          { start: 0, end: 1, text: "Can we test this" },
          { start: 1, end: 1.2, text: "?" },
        ],
      },
      "plain"
    );

    expect(result.text).toBe("Can we test this?");
  });

  it("formats timestamped output", () => {
    const result = formatTranscript(sample, "timestamped");
    expect(result.text).toContain("[00:00:00] Speaker 1: Hello there");
    expect(result.text).toContain("[00:00:01] Speaker 2: Hi back How are you?");
  });

  it("formats valid SRT output", () => {
    const result = formatTranscript(sample, "srt");
    expect(result.text).toContain("1\n00:00:00,000 --> 00:00:01,500\nSpeaker 1: Hello there");
    expect(result.text).toContain("2\n00:00:01,500 --> 00:00:03,000\nSpeaker 2: Hi back");
  });

  it("handles no segments", () => {
    const result = formatTranscript({}, "plain");
    expect(result.speakerCount).toBe(0);
    expect(result.text).toBe("");
  });

  it.each(["plain", "timestamped", "speakers", "srt"])(
    "preserves repeated replies by different speakers in %s",
    (format) => {
      const result = formatTranscript(
        {
          segments: [
            { start: 0, end: 1, speaker: "Speaker 1", text: "Ja." },
            { start: 1, end: 2, speaker: "Speaker 2", text: "Ja." },
            { start: 2, end: 3, speaker: "Speaker 3", text: "Ja." },
          ],
        },
        format
      );
      expect(result.text.match(/Ja\./g)).toHaveLength(3);
      expect(result.text).toContain("Speaker 2: Ja.");
      expect(result.text).toContain("Speaker 3: Ja.");
    }
  );

  it("keeps a longer reply that contains the previous speaker's words", () => {
    const result = formatTranscript({
      segments: [
        { start: 0, end: 1, speaker: "Speaker 1", text: "Kan vi starte nu?" },
        { start: 1, end: 3, speaker: "Speaker 2", text: "Kan vi starte nu? Ja, det kan vi." },
      ],
    });
    expect(result.text).toContain("Speaker 2: Kan vi starte nu? Ja, det kan vi.");
  });

  it("does not silently edit repeated words in an explicitly labelled transcript", () => {
    expect(
      formatTranscript({
        segments: [{ start: 0, end: 3, speaker: "Speaker 1", text: "Nej. Nej. Nej." }],
      }).text
    ).toBe("Nej. Nej. Nej.");
  });

  it("does not count unknown speech as another identified speaker", () => {
    const result = formatTranscript({
      segments: [{ start: 0, end: 1, speaker: "Unknown speaker", text: "Hello" }],
    });
    expect(result.speakerCount).toBe(0);
    expect(result.text).toBe("Unknown speaker: Hello");
  });

  it("uses explicit speaker labels when present", () => {
    const result = formatTranscript(
      { segments: [{ start: 0, end: 1, speaker: "Alex", text: "Test" }] },
      "timestamped"
    );
    expect(result.speakerCount).toBe(1);
    expect(result.text).toBe("[00:00:00] Alex: Test");
  });

  it("turns trailing TinyDiarize markers into alternating speaker labels", () => {
    const result = formatTranscript(
      {
        segments: [
          { start: 0, end: 1, text: "Host question [SPEAKER_TURN]" },
          { start: 1, end: 2, text: "Guest answer [SPEAKER_TURN]" },
          { start: 2, end: 3, text: "Host follow-up" },
        ],
      },
      "plain",
      { includeSpeakers: true }
    );

    expect(result.speakerCount).toBe(2);
    expect(result.text).toContain("Speaker 1: Host question");
    expect(result.text).toContain("Speaker 2: Guest answer");
  });
});

describe("speakers format: the Transcribe page with speaker labels on", () => {
  const lines = (verboseJson: object) => formatTranscript(verboseJson, "speakers").text.split("\n");
  const voice = (speaker: string, start: number, end: number, text: string) => ({
    start,
    end,
    speaker,
    text: ` ${text}`,
  });

  it("starts every speaker turn with the time it started", () => {
    expect(
      lines({
        segments: [
          voice("Speaker 1", 0, 5.3, "Thanks for joining me."),
          voice("Speaker 2", 5.75, 9, "Happy to be here."),
          voice("Speaker 2", 9, 12.2, "It started with slow handwriting."),
          voice("Speaker 1", 12.875, 15.1, "So you record the whole lecture?"),
        ],
      })
    ).toEqual([
      "[00:00:00] Speaker 1: Thanks for joining me.",
      "[00:00:05] Speaker 2: Happy to be here. It started with slow handwriting.",
      "[00:00:12] Speaker 1: So you record the whole lecture?",
    ]);
  });

  it("stamps the turns English turn detection finds", () => {
    expect(lines(sample)).toEqual([
      "[00:00:00] Speaker 1: Hello there",
      "[00:00:01] Speaker 2: Hi back How are you?",
    ]);
  });

  it("writes the hours on a recording longer than an hour", () => {
    expect(
      lines({
        segments: [
          voice("Speaker 1", 3599.6, 3601, "Just before the hour."),
          voice("Speaker 2", 3601.2, 3604, "Just after it."),
          voice("Speaker 1", 3725.4, 3728, "Two minutes later."),
          voice("Speaker 2", 36000, 36002, "Ten hours in."),
        ],
      })
    ).toEqual([
      "[00:59:59] Speaker 1: Just before the hour.",
      "[01:00:01] Speaker 2: Just after it.",
      "[01:02:05] Speaker 1: Two minutes later.",
      "[10:00:00] Speaker 2: Ten hours in.",
    ]);
  });

  it("stamps a turn on a chunk seam from the repaired timeline", () => {
    // The seam measured on the 32:04 fixture (see transcribeFileAudit), an hour
    // later and with a speaker change on it: the earlier chunk's last segments
    // run past the seam, on top of the next chunk's first words.
    expect(
      lines({
        segments: [
          voice("Speaker 1", 4855.0, 4860.559, "trailing words of the earlier chunk"),
          voice("Speaker 1", 4860.559, 4860.559, "good."),
          voice("Speaker 2", 4860.0, 4864.2, "slow and my professor talks fast."),
        ],
      })
    ).toEqual([
      "[01:20:55] Speaker 1: trailing words of the earlier chunk good.",
      "[01:21:00] Speaker 2: slow and my professor talks fast.",
    ]);
  });

  it("never stamps a turn earlier than the turn before it", () => {
    // Read raw, the overrunning "Mm." starts at 1:21:01 and the next chunk's
    // first turn at 1:21:00, so the stamps would run backwards.
    expect(
      lines({
        segments: [
          voice("Speaker 1", 4855.0, 4860.4, "trailing words of the earlier chunk"),
          voice("Speaker 2", 4861.2, 4861.2, "Mm."),
          voice("Speaker 1", 4860.0, 4864.2, "slow and my professor talks fast."),
        ],
      })
    ).toEqual([
      "[01:20:55] Speaker 1: trailing words of the earlier chunk",
      "[01:21:01] Speaker 2: Mm.",
      "[01:21:01] Speaker 1: slow and my professor talks fast.",
    ]);
  });

  it("gives one voice a stamped line about once a minute, without a label", () => {
    // A lecture where only one voice is found is a single turn. Stamped once,
    // it would be one line at [00:00:00], however long the recording.
    const segments = Array.from({ length: 13 }, (_, i) =>
      voice("Speaker 1", i * 10, i * 10 + 9, `Sentence ${i + 1}.`)
    );
    expect(lines({ segments })).toEqual([
      "[00:00:00] Sentence 1. Sentence 2. Sentence 3. Sentence 4. Sentence 5. Sentence 6.",
      "[00:01:00] Sentence 7. Sentence 8. Sentence 9. Sentence 10. Sentence 11. Sentence 12.",
      "[00:02:00] Sentence 13.",
    ]);
  });

  it("starts the new line where a sentence ends, not inside one", () => {
    // Real Whisper segments from the control fixture: they wrap at about 60
    // characters, so the first one past a minute starts mid-sentence.
    expect(
      lines({
        segments: [
          voice("Speaker 1", 0.14, 3.19, "I have been keeping my lecture notes"),
          voice(
            "Speaker 1",
            3.19,
            58.4,
            "and I only speak into it when something is worth keeping."
          ),
          voice(
            "Speaker 1",
            59.74,
            62.98,
            "Afterwards, I read the transcript on the train home, and"
          ),
          voice("Speaker 1", 63.05, 64.4, "mark the parts I did not understand."),
          voice("Speaker 1", 65.74, 69.61, "It is not perfect, and it never will be."),
        ],
      })
    ).toEqual([
      "[00:00:00] I have been keeping my lecture notes and I only speak into it when something is worth keeping. Afterwards, I read the transcript on the train home, and mark the parts I did not understand.",
      "[00:01:05] It is not perfect, and it never will be.",
    ]);
  });

  it("breaks a line without sentence ends at a minute and a half", () => {
    const segments = Array.from({ length: 12 }, (_, i) =>
      voice("Speaker 1", i * 10, i * 10 + 9, `words without an end ${i + 1}`)
    );
    expect(lines({ segments }).map((line) => line.slice(0, 10))).toEqual([
      "[00:00:00]",
      "[00:01:30]",
    ]);
  });

  it("repeats the speaker on each line of an answer longer than a minute", () => {
    const answer = Array.from({ length: 8 }, (_, i) =>
      voice("Speaker 2", 5 + i * 10, 14 + i * 10, `Answer ${i + 1}.`)
    );
    expect(
      lines({
        segments: [
          voice("Speaker 1", 0, 4, "Question?"),
          ...answer,
          voice("Speaker 1", 86, 88, "Thanks."),
        ],
      })
    ).toEqual([
      "[00:00:00] Speaker 1: Question?",
      "[00:00:05] Speaker 2: Answer 1. Answer 2. Answer 3. Answer 4. Answer 5. Answer 6.",
      "[00:01:05] Speaker 2: Answer 7. Answer 8.",
      "[00:01:26] Speaker 1: Thanks.",
    ]);
  });

  it("stamps a speaker who comes back after a break with the time they came back", () => {
    expect(
      lines({
        segments: [
          voice("Speaker 1", 0, 3, "Let's take a break."),
          voice("Speaker 2", 3.5, 5, "Good idea."),
          voice("Speaker 2", 6, 8, "Ten minutes."),
          voice("Speaker 2", 608, 611, "Welcome back."),
        ],
      })
    ).toEqual([
      "[00:00:00] Speaker 1: Let's take a break.",
      "[00:00:03] Speaker 2: Good idea. Ten minutes.",
      "[00:10:08] Speaker 2: Welcome back.",
    ]);
  });

  it("stamps speech that no speaker was found for", () => {
    expect(
      lines({
        segments: [voice("Speaker 1", 0, 2, "Hello."), voice("Unknown speaker", 2.5, 3, "Mm.")],
      })
    ).toEqual(["[00:00:00] Speaker 1: Hello.", "[00:00:02] Unknown speaker: Mm."]);
  });

  it("leaves the SRT file as it was", () => {
    expect(formatTranscript(sample, "speakers").srt).toBe(
      [
        "1\n00:00:00,000 --> 00:00:01,500\nSpeaker 1: Hello there",
        "2\n00:00:01,500 --> 00:00:03,000\nSpeaker 2: Hi back",
        "3\n00:00:03,000 --> 00:00:04,000\nSpeaker 2: How are you?",
      ].join("\n\n")
    );
  });

  it("leaves output with speaker labels off stamped once per segment", () => {
    const segments = Array.from({ length: 13 }, (_, i) => ({
      start: i * 10,
      end: i * 10 + 9,
      text: ` Sentence ${i + 1}.`,
    }));
    const text = formatTranscript({ segments }, "timestamped", { includeSpeakers: false }).text;

    expect(text.split("\n")).toHaveLength(13);
    expect(text.split("\n")[6]).toBe("[00:01:00] Sentence 7.");
  });
});
