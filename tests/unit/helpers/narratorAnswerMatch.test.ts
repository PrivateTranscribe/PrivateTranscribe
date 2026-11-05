import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { matchAnswer } = require("../../../src/helpers/narrator/answerMatch");

const label = (text: string, options: string[]) => matchAnswer(text, options)?.label ?? null;

describe("voice answer matching", () => {
  it("picks the label whose words were said, with the punctuation and case speech adds", () => {
    expect(label("Merge it.", ["Merge it", "Not now"])).toBe("Merge it");
    expect(label("not now", ["Merge it", "Not now"])).toBe("Not now");
  });

  it("hears a spoken number as the label's digit", () => {
    expect(label("Fix one.", ["Yes, fix 1", "Yes, fix 2"])).toBe("Yes, fix 1");
    expect(label("yes fix two", ["Yes, fix 1", "Yes, fix 2"])).toBe("Yes, fix 2");
  });

  it("lets sounds and padding around the answer pass", () => {
    expect(label("Uh, let's go with not now, please.", ["Merge it", "Not now"])).toBe("Not now");
  });

  it("answers nothing when two labels fit as well", () => {
    expect(label("yes fix", ["Yes, fix 1", "Yes, fix 2"])).toBeNull();
  });

  it("answers nothing for words no label offers, so recognition cannot invent a pick", () => {
    expect(label("Thank you.", ["Merge it", "Not now"])).toBeNull();
    expect(label("yes", ["Commit it for me now"])).toBeNull();
    expect(label("", ["Merge it"])).toBeNull();
  });

  it("answers nothing for talk longer than an answer", () => {
    const talk = "so then he went around the corner and merge it was what the raid leader shouted";
    expect(label(talk, ["Merge it", "Not now"])).toBeNull();
  });

  it("keeps a filler word that a label itself uses", () => {
    expect(label("go with B", ["Go with A", "Go with B"])).toBe("Go with B");
  });

  it("answers nothing without options", () => {
    expect(matchAnswer("merge it", [])).toBeNull();
    expect(matchAnswer("merge it", undefined)).toBeNull();
  });

  it("never turns a no around into the label it denies", () => {
    expect(label("Don't merge it.", ["Merge it", "Not now"])).toBeNull();
    expect(label("Merge it? No.", ["Merge it", "Not now"])).toBeNull();
    expect(label("do not fix it", ["Skip it", "Fix it"])).toBeNull();
    expect(label("I can't merge it", ["Merge it"])).toBeNull();
    expect(label("flet den ikke", ["Ja, flet den", "Ikke nu"])).toBeNull();
  });

  it("still hears a no that a label says itself", () => {
    expect(label("No, not now.", ["Merge it", "Not now"])).toBe("Not now");
    expect(label("no", ["Yes", "No"])).toBe("No");
    expect(label("yes", ["Yes", "No"])).toBe("Yes");
    expect(label("don't merge", ["Don't merge", "Merge"])).toBe("Don't merge");
    expect(label("merge", ["Don't merge", "Merge"])).toBe("Merge");
    expect(label("nej, ikke nu", ["Ja, flet den", "Ikke nu"])).toBe("Ikke nu");
  });

  it("reads Danish letters as letters", () => {
    expect(label("Bare kør på", ["Bare kør på", "Vent til i morgen"])).toBe("Bare kør på");
  });
});
