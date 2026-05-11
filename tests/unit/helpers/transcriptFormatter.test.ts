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

  it("uses explicit speaker labels when present", () => {
    const result = formatTranscript({ segments: [{ start: 0, end: 1, speaker: "Alex", text: "Test" }] }, "timestamped");
    expect(result.speakerCount).toBe(1);
    expect(result.text).toBe("[00:00:00] Alex: Test");
  });
});
