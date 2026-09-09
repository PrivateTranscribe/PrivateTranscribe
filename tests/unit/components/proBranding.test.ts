import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("Pro branding", () => {
  it("defines the website's Pro purple as a theme token", () => {
    const theme = readSource("src/index.css");

    // The accent still has to be this exact purple — it now lives in @theme
    // instead of being retyped as a hex literal in every component.
    expect(theme).toContain("--color-pro: #a885ff");
    expect(theme).toContain("--color-pro-deep: #2d1b69");
  });

  it("uses the Pro token in the settings Pro section", () => {
    const source = readSource("src/components/ProSettingsSection.tsx");

    expect(source).toMatch(/\b(bg|text|border)-pro\b/);
    expect(source).toContain("bg-pro-deep");
    expect(source).not.toContain("validated automatically when online");
    expect(source).toContain(
      "Unlimited private dictation unlocked with your one-time Pro purchase"
    );
    // Success states must not borrow green from Tailwind's stock palette.
    expect(source).not.toMatch(/\b(bg|text|border)-green-\d{3}\b/);
  });

  it("distinguishes locked Beta badges from purple Pro badges", () => {
    // AI Enhancement mixes public coding prompts with tester-only cleanup.
    // Its scoped lock explanation is covered by betaFeatureLabelling.test.ts.
    const files = ["src/components/pages/ActionEnginePage.tsx"];

    // These pages used to spell the purple out in a hand-rolled pill each.
    // The token now lives once inside the shared beta badge, so follow it
    // there rather than asserting on markup that no longer exists.
    for (const file of files) {
      expect(readSource(file), file).toContain("<BetaBadge locked");
    }
    expect(readSource("src/components/ui/BetaBadge.tsx")).toContain('variant={locked ? "warning"');

    // The sidebar no longer badges anything: locked features are not listed
    // there at all, so the pro token only has to exist in the shared badge.
    expect(readSource("src/components/ui/badge.tsx")).toContain("bg-pro/15");
  });

  it("never reintroduces the Pro purple as a raw hex literal", () => {
    const files = [
      "src/components/AppSidebar.tsx",
      "src/components/ProSettingsSection.tsx",
      "src/components/pages/AIEnhancementPage.tsx",
      "src/components/pages/ActionEnginePage.tsx",
    ];

    for (const file of files) {
      expect(readSource(file).toUpperCase(), file).not.toContain("#A885FF");
    }
  });
});
