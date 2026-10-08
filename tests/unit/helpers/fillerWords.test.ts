import { describe, it, expect } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { removeFillerWords } = require("../../../src/helpers/fillerWords");

const EN = { languages: ["en"] };

describe("removeFillerWords", () => {
  it.each([
    [
      "So I'm the login form, when I submit empty it uh crashes, I think.",
      "So I'm the login form, when I submit empty it crashes, I think.",
    ],
    ["Uh, so I was thinking.", "So I was thinking."],
    ["Um so we should, um, ship it.", "So we should, ship it."],
    ["It works. Uhm, mostly.", "It works. Mostly."],
    ["Det er øh en god idé.", "Det er en god idé."],
    ["Øhm, jeg tror det virker.", "Jeg tror det virker."],
    ["We need hmm more tests.", "We need more tests."],
    ["Done um.", "Done."],
    ["It works, uh.", "It works."],
    ["We uh um go now.", "We go now."],
    ["Uh um so we go.", "So we go."],
    ["Use a 5 mm drill uh bit.", "Use a 5 mm drill bit."],
    ["Open the .gitignore file uh now.", "Open the .gitignore file now."],
    ["Uh, iPhone is great.", "iPhone is great."],
    ["See e.g. um the docs.", "See e.g. the docs."],
  ])("cleans %j", (input, expected) => {
    expect(removeFillerWords(input, EN)).toBe(expected);
  });

  it.each([
    "Det er en god idé.",
    "Ah, I see what you mean.",
    "Oh no, the build broke.",
    "The umbrella and the hummus were in the drum.",
    "Error: ERM module not found.",
    "The wall is 12 mm thick.",
    "",
  ])("leaves %j unchanged", (input) => {
    expect(removeFillerWords(input, EN)).toBe(input);
  });

  it.each(["Uh.", "Hmm?", "Hm, hm, hm.", "Um"])(
    "turns a filler-only result %j into no speech",
    (input) => {
      expect(removeFillerWords(input, EN)).toBe("");
    }
  );

  describe("the word um", () => {
    it.each([
      ["Wir treffen uns um 8 Uhr.", ["de", "en"]],
      ["Es geht um Geld.", ["de"]],
      ["Um zu gewinnen, muss man üben.", ["de-DE"]],
      ["Eu tenho um carro.", ["pt"]],
      ["Um dia eu vou.", ["pt", "da"]],
    ])("stays in %j for %j", (input, languages) => {
      expect(removeFillerWords(input, { languages })).toBe(input);
    });

    it("stays when the spoken languages are unknown", () => {
      expect(removeFillerWords("It um works.")).toBe("It um works.");
      expect(removeFillerWords("It um works.", { languages: [] })).toBe("It um works.");
    });

    it("still lets other fillers go when um is a word", () => {
      expect(removeFillerWords("Es geht uh um Geld.", { languages: ["de"] })).toBe(
        "Es geht um Geld."
      );
    });

    it("goes for English and Danish speakers", () => {
      expect(removeFillerWords("It um works.", { languages: ["en", "da"] })).toBe("It works.");
    });
  });

  it("passes through non-strings", () => {
    expect(removeFillerWords(undefined)).toBeUndefined();
  });
});
