import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const readSource = (relativePath: string): string =>
  fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

const BETA_SURFACES = [
  "src/components/pages/CorrectionMemoryPage.tsx",
  "src/components/pages/VoiceAssistantPage.tsx",
  "src/components/pages/AIEnhancementPage.tsx",
  "src/components/pages/ActionEnginePage.tsx",
];

/**
 * A locked beta control has to look locked. A disabled toggle whose only
 * explanation sits in small description text reads as a bug in the app, and
 * the app previously used three different words for the same state: "Beta" in
 * the sidebar, "Tester" on page headers, "Approved testers only" on one page.
 */
describe("beta feature labelling", () => {
  it("says it with one component instead of hand-rolled pills", () => {
    for (const file of BETA_SURFACES) {
      const source = readSource(file);
      expect(source, `${file} should use the shared badge`).toContain("<BetaBadge");
      expect(source, `${file} should not hand-roll a tester pill`).not.toContain("Tester\n");
      expect(source, `${file} should not invent another phrasing`).not.toContain(
        "Approved testers only"
      );
    }
  });

  it("badges the locked controls in Settings, not only their descriptions", () => {
    const settings = readSource("src/components/SettingsPage.tsx");

    // Smart Context and Auto-learn corrections are the two toggles that sit
    // disabled for everyone without tester access.
    expect(settings).toContain("badge={smartContextUnlocked ? undefined : <BetaBadge locked />}");
    expect(settings).toContain(
      "badge={correctionMemoryUnlocked ? undefined : <BetaBadge locked />}"
    );

    // The badge carries the "Beta" word now, so the description should explain
    // the state rather than repeat the label.
    expect(settings).not.toContain("Beta - approved tester access is required");
  });

  it("keeps the badge slots available on the shared settings primitives", () => {
    expect(readSource("src/components/ui/SettingsSection.tsx")).toContain(
      "badge?: React.ReactNode"
    );
    expect(readSource("src/components/SettingsPage.tsx")).toContain("badge?: React.ReactNode");
  });

  it("offers a way out of every locked surface", () => {
    // A locked control with no path forward is worse than a hidden one: it
    // names what the user is missing and then leaves them nowhere to go.
    for (const file of BETA_SURFACES) {
      expect(readSource(file), `${file} should link out`).toContain("<BetaAccessLink");
    }

    const settings = readSource("src/components/SettingsPage.tsx");
    // Both locked cards and both locked toggles.
    expect(settings.match(/<BetaAccessLink/g) ?? []).toHaveLength(4);
  });

  it("keeps the beta destination in one place", () => {
    const links = readSource("src/utils/externalLinks.ts");
    expect(links).toContain("BETA_ACCESS_URL");

    // The site has no /beta route, and the footer's own "Tester program" link
    // points at a #waitlist anchor that is not on the page. Pointing the app
    // at either would send users somewhere that does not exist.
    expect(links).not.toContain("privatetranscribe.com/beta");
    expect(links).toContain("#pricing");

    const component = readSource("src/components/ui/BetaAccessLink.tsx");
    expect(component).toContain("BETA_ACCESS_URL");
    // Opens in the system browser, never inside the Electron window.
    expect(component).toContain("openExternalLink");
  });

  it("still gates on the entitlement rather than on the badge", () => {
    // Labelling must never become the enforcement. Every badged surface reads
    // the same entitlement helper that the runtime paths do.
    for (const file of BETA_SURFACES) {
      expect(readSource(file), `${file} should resolve access from the entitlement`).toContain(
        "isFeatureUnlocked("
      );
    }
  });
});
