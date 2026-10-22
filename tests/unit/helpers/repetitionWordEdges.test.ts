import { tmpdir } from "os";
import { describe, expect, it, vi } from "vitest";
import { formatTranscript } from "../../../src/helpers/transcriptFormatter";

vi.mock("electron", () => ({
  app: {
    getPath: () => tmpdir(),
    isReady: () => false,
  },
}));

const WhisperManager = require("../../../src/helpers/whisper");

const plainFileText = (text: string) =>
  formatTranscript({ text, segments: [{ start: 0, end: 5, text: ` ${text}` }] }, "plain", {
    includeSpeakers: false,
  }).text;

// A repeat counts only as a whole word or phrase. The start of the next word
// is not another copy of the one before it.
describe("repetition cleanup word edges", () => {
  it.each([
    ["We moved to the the theory part.", "We moved to the the theory part."],
    ["Let us go to to tomorrow's list.", "Let us go to to tomorrow's list."],
  ])("keeps a file transcript's word that starts with the repeat: %j", (input, expected) => {
    expect(plainFileText(input)).toBe(expected);
  });

  it("still collapses a real triple repeat in a file transcript", () => {
    expect(plainFileText("Ja. Ja. Ja. Okay then.")).toBe("Ja. Okay then.");
  });

  it("keeps a dictated phrase whose last word grows into a new word", () => {
    const manager = new WhisperManager();

    expect(manager.removeRepetitions("I like it I like it I like items")).toBe(
      "I like it I like it I like items"
    );
  });

  it("still collapses a dictated phrase repeated three times", () => {
    const manager = new WhisperManager();

    expect(manager.removeRepetitions("I like it I like it I like it a lot")).toBe(
      "I like it a lot"
    );
  });

  it("still collapses a phrase whose last copy ends in punctuation", () => {
    const manager = new WhisperManager();

    expect(manager.removeRepetitions("I like it I like it I like it.")).toBe("I like it.");
    expect(plainFileText("We go now we go now we go now.")).toBe("We go now.");
  });

  it("does not start a repeat in the middle of a word", () => {
    expect(plainFileText("Bathe the the boat.")).toBe("Bathe the the boat.");
  });
});
