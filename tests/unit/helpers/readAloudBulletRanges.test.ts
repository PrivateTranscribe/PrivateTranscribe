import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "win32")(
  "matches bullet text without requiring its copied marker",
  () => {
    const cases = [
      {
        document: "Removed the flagged test helper.",
        copied: "- Removed the flagged test helper.",
      },
      { document: "A quiet morning.", copied: "• A quiet morning." },
      { document: "First item.", copied: "1. First item." },
      { document: "A short\nwrapped item.", copied: "- A short wrapped item." },
      { document: "First item.\n• Second item.", copied: "- First item.\n- Second item." },
      { document: "Yes yes yes.", copied: "- Yes yes yes." },
      { document: "A well-known author.", copied: "- A well-known author." },
      {
        document: "Different words between a short and wrapped item.",
        copied: "- A short wrapped item.",
      },
      { document: "One item.", copied: "- One item." },
      { document: "Only", copied: "* Only" },
      { document: "• One item.", copied: "- One item." },
      { document: "One item.", copied: "  12) One item." },
      {
        document: "A different sentence. A short\nwrapped item.",
        copied: "- A short wrapped item.",
      },
      { document: "Plain text.", copied: "Plain text." },
      { document: "A - B", copied: "A - B" },
    ];
    const result: {
      matched: boolean;
      words: { start: number; sourceStart: number; sourceEnd: number; text: string }[];
    }[] = JSON.parse(
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          path.resolve("tests/fixtures/readAloudTextRanges.ps1"),
          "-CaseJsonBase64",
          Buffer.from(JSON.stringify(cases)).toString("base64"),
        ],
        { encoding: "utf8", windowsHide: true, timeout: 15000 }
      )
    );
    const expectedWordCounts = [5, 3, 2, 4, 4, 3, 3, 0, 2, 1, 2, 2, 4, 2, 3];
    for (let i = 0; i < cases.length; i++) {
      expect(result[i].matched, JSON.stringify(cases[i])).toBe(i !== 7);
      expect(result[i].words).toHaveLength(expectedWordCounts[i]);
      if (i === 7) continue;
      for (const word of result[i].words) {
        expect(cases[i].copied.slice(word.start, word.start + word.text.length)).toBe(word.text);
        expect(cases[i].document.slice(word.sourceStart, word.sourceEnd)).toBe(word.text);
      }
    }
    expect(result[0].words[0]).toMatchObject({ text: "Removed", start: 2, sourceStart: 0 });
    expect(result[5].words.map((word) => word.sourceStart)).toEqual([0, 4, 8]);
    expect(result[6].words.map((word) => word.text)).toContain("well-known");
  }
);
