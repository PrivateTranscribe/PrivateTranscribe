import { describe, expect, it } from "vitest";
import { getParakeetModelInfo } from "../../../src/models/ModelRegistry";

// The 25 languages on the nvidia/parakeet-tdt-0.6b-v3 model card. Offering any
// other language lets a user pick one the model has never been trained on.
const MODEL_CARD_LANGUAGES = [
  "bg",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "et",
  "fi",
  "fr",
  "de",
  "el",
  "hu",
  "it",
  "lv",
  "lt",
  "mt",
  "pl",
  "pt",
  "ro",
  "sk",
  "sl",
  "es",
  "sv",
  "ru",
  "uk",
];

describe("Parakeet supported languages", () => {
  it("lists exactly the model card's 25 languages", () => {
    const info = getParakeetModelInfo("parakeet-tdt-0.6b-v3");
    expect(info).toBeDefined();
    expect([...info!.supportedLanguages].sort()).toEqual([...MODEL_CARD_LANGUAGES].sort());
    expect(new Set(info!.supportedLanguages).size).toBe(25);
    expect(info!.description).toContain("25 languages");
  });
});
