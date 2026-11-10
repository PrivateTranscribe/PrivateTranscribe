import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { matchAnswer } = require("../../../src/helpers/narrator/answerMatch");

const label = (text: string, options: string[], language?: "da" | "en") =>
  matchAnswer(text, options, { language })?.label ?? null;

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

  it("hears a Danish spoken number as the label's digit, in a Danish question", () => {
    expect(label("Ret to.", ["Ret 1", "Ret 2"], "da")).toBe("Ret 2");
    expect(label("mulighed fire", ["Mulighed 3", "Mulighed 4"], "da")).toBe("Mulighed 4");
    expect(label("ja, fiks tre", ["Ja, fiks 2", "Ja, fiks 3"], "da")).toBe("Ja, fiks 3");
    // English numbers still count in a Danish question, as its labels may be English.
    expect(label("fix two", ["Fix 1", "Fix 2"], "da")).toBe("Fix 2");
  });

  it("leaves Danish number words alone in an English question, where they are other words", () => {
    // "to" is two in Danish; here it is the English word, and no pick.
    expect(label("I want to fix", ["Fix 1", "Fix 2"], "en")).toBeNull();
    expect(label("I want to fix", ["Fix 1", "Fix 2"])).toBeNull();
    expect(label("go to main", ["Go to main", "Stay here"], "en")).toBe("Go to main");
  });

  it("leaves 'en' and 'et' as words: they are also 'a', and must not pick a label with a 1", () => {
    expect(label("en test", ["Kør test 1", "Skriv en test mere"], "da")).toBeNull();
    expect(label("en ny fil", ["Fil 1", "En ny fil til testen"], "da")).toBe(
      "En ny fil til testen"
    );
    expect(label("skriv en test", ["Kør test 1", "Skriv en test mere"], "da")).toBe(
      "Skriv en test mere"
    );
    expect(label("et nyt vindue", ["Vindue 1", "Åbn et nyt vindue"], "da")).toBe(
      "Åbn et nyt vindue"
    );
  });

  it("takes a plain yes or no as the one label that begins with it", () => {
    expect(label("Ja.", ["Ja, merge", "Ikke nu"], "da")).toBe("Ja, merge");
    expect(label("nej", ["Ja, merge den", "Nej, vent"], "da")).toBe("Nej, vent");
    expect(label("ja tak", ["Ja, merge", "Ikke nu"], "da")).toBe("Ja, merge");
    expect(label("Yes.", ["Yes, merge it", "Not now"], "en")).toBe("Yes, merge it");
    expect(label("no", ["Yes, merge it", "No, wait for CI"], "en")).toBe("No, wait for CI");
  });

  it("answers nothing for a plain yes when two labels begin with it, or none does", () => {
    expect(label("ja", ["Ja, fiks 1", "Ja, fiks 2"], "da")).toBeNull();
    expect(label("ja", ["Merge den", "Ikke nu"], "da")).toBeNull();
    expect(label("nej", ["Ja, merge", "Ikke nu"], "da")).toBeNull();
    // A first word that is part of saying yes is not a no: "No problem" must not be picked.
    expect(label("no", ["No problem, merge it", "Wait for CI"], "en")).toBeNull();
    expect(label("no", ["No problem, merge it", "No, wait for CI"], "en")).toBe("No, wait for CI");
    expect(label("yes", ["Yes merge it", "Not now"], "en")).toBeNull();
    // A label that is the word itself still wins over one that only begins with it.
    expect(label("ja", ["Ja", "Ja, og push"], "da")).toBe("Ja");
  });

  it("reads Danish letters as letters", () => {
    expect(label("Bare kør på", ["Bare kør på", "Vent til i morgen"])).toBe("Bare kør på");
  });
});
