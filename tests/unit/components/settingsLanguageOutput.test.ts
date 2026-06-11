import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const readSettingsPage = () =>
  fs.readFileSync(path.join(process.cwd(), "src", "components", "SettingsPage.tsx"), "utf8");

describe("Settings language output UX", () => {
  it("uses explicit spoken/output language labels instead of the old ambiguous wording", () => {
    const contents = readSettingsPage();

    expect(contents).toContain('label="Spoken language"');
    expect(contents).toContain('label="Output language"');
    expect(contents).toContain("Same as speech");
    expect(contents).toContain("English");
    expect(contents).not.toContain('label="I speak"');
    expect(contents).not.toContain('label="Translate to English"');
  });

  it("disables stale English output unless speech language and model support make it valid", () => {
    const contents = readSettingsPage();

    expect(contents).toContain("hasExplicitNonEnglishSpeechLanguage");
    expect(contents).toContain("const canTranslateToEnglish");
    expect(contents).toContain('preferredLanguage !== "auto"');
    expect(contents).toContain('preferredLanguage !== "en"');
    expect(contents).toContain('if (!canTranslateToEnglish && translateToEnglish === "on")');
    expect(contents).toContain('setTranslateToEnglish("off")');
  });

  it("explains the Danish launch-critical default clearly", () => {
    const contents = readSettingsPage();

    expect(contents).toContain("For Danish dictation, choose Danish instead of Auto");
    expect(contents).toContain("Same as speech keeps Danish as Danish");
    expect(contents).toContain("Whisper Turbo does not reliably support translation");
  });
});
