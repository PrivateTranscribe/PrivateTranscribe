import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const SWITCH_IMPORT = /from "(\.\.\/)+utils\/betaFeatures"/;

const LOCKED_PAGES = {
  "src/components/pages/AIEnhancementPage.tsx": "Dictation enhancement is in beta",
  "src/components/pages/ActionEnginePage.tsx": "Action Engine is in beta",
  "src/components/pages/CorrectionMemoryPage.tsx": "Correction Memory is in beta",
};

describe("beta features switch contract", () => {
  it("checks the switch in every beta runtime path", () => {
    const audioHook = readSource("src/hooks/useAudioRecording.js");
    const audioManager = readSource("src/helpers/audioManager.js");
    const contextPipeline = readSource("src/helpers/contextPipeline.js");

    expect(audioHook).toMatch(SWITCH_IMPORT);
    expect(audioHook).toContain('isBetaFeatureUnlocked("correction-memory")');
    expect(audioManager).toContain('this._checkBetaFeatureAccess("ai-enhancement")');
    expect(contextPipeline).toMatch(SWITCH_IMPORT);
    expect(contextPipeline).toContain('isFeatureUnlocked("smart-context")');

    // The Action Engine matters most here. Its other surfaces need the user to
    // open a page that is itself gated, but this one fires off the end of every
    // dictation without anyone visiting it, so losing the check would run voice
    // commands for people who never turned beta features on.
    expect(audioHook).toContain('isBetaFeatureUnlocked("action-engine")');
  });

  it("gates beta page reads and Action Engine operations", () => {
    const correctionPage = readSource("src/components/pages/CorrectionMemoryPage.tsx");
    const settings = readSource("src/components/SettingsPage.tsx");
    const actionHook = readSource("src/hooks/useActionEngine.ts");
    const actionPage = readSource("src/components/pages/ActionEnginePage.tsx");

    expect(correctionPage).toContain('isBetaFeature("correction-memory")');
    expect(correctionPage).toContain("if (!isUnlocked)");
    expect(correctionPage).toContain("if (!isUnlocked) return;");
    // Settings no longer reads correction memory at all; the page owns it.
    expect(settings).not.toContain("getCorrectionMemory");
    expect(actionPage).toContain('isBetaFeature("action-engine")');
    expect(actionPage).toContain("useActionEngine(isUnlocked)");
    // A caller that forgets to pass the switch gets a locked hook, not an open one.
    expect(actionHook).toContain("export function useActionEngine(isUnlocked = false)");
    expect(actionHook).toContain("if (!isUnlocked) return null;");
    expect(actionHook).toContain('error: "Turn on beta features to run actions."');
  });

  it("says what a beta is on every locked page", () => {
    for (const [file, title] of Object.entries(LOCKED_PAGES)) {
      const source = readSource(file).replace(/\s+/g, " ");
      expect(source, file).toContain(title);
      expect(source, file).toContain("We are still building it, so it can change between updates.");
    }
  });

  it("never mentions testers, licences or Pro on a beta surface", () => {
    for (const file of [
      ...Object.keys(LOCKED_PAGES),
      "src/components/pages/DictionaryPage.tsx",
      "src/components/pages/ReadAloudPage.tsx",
      "src/components/ui/BetaAccessLink.tsx",
      "src/hooks/useActionEngine.ts",
    ]) {
      const source = readSource(file);
      expect(source, file).not.toMatch(/tester|early access|apply for|licen[cs]e/i);
      expect(source, file).not.toMatch(/\bPro\b/);
    }
  });
});
