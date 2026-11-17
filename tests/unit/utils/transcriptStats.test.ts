import { describe, expect, it } from "vitest";
import { countTranscript } from "../../../src/utils/transcriptStats";

describe("countTranscript", () => {
  it("counts the words and lines of a plain transcript", () => {
    expect(countTranscript("Kan vi starte?\nJa, det kan vi.")).toEqual({ words: 7, lines: 2 });
  });

  it("does not count line timestamps as words", () => {
    expect(countTranscript("[00:00:00] Kan vi starte?\n[00:00:02] Ja.")).toEqual({
      words: 4,
      lines: 2,
    });
  });

  it("does not count the speaker after a timestamp as words", () => {
    expect(
      countTranscript(
        "[00:00:00] Speaker 1: Kan vi starte?\n[01:02:05] Speaker 12: Ja.\n[10:00:00] Unknown speaker: Mm."
      )
    ).toEqual({ words: 5, lines: 3 });
  });

  it("counts a speaker's name that was said rather than labelled", () => {
    expect(countTranscript("Speaker 2: you are next.")).toEqual({ words: 5, lines: 1 });
  });

  it("ignores blank lines and surrounding space", () => {
    expect(countTranscript("  \n\n[00:00:01] Hej.  \n\n")).toEqual({ words: 1, lines: 1 });
    expect(countTranscript("")).toEqual({ words: 0, lines: 0 });
  });
});
