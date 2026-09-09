import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const readSource = (relativePath: string): string =>
  fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

// These whole pages are tester-only. AI Enhancement now mixes tester-only
// dictation cleanup with public coding prompts; Read Aloud is part of Starter.
const BETA_SURFACES = [
  "src/components/pages/CorrectionMemoryPage.tsx",
  "src/components/pages/ActionEnginePage.tsx",
  // ConversePage is deliberately absent: Converse left the tester gate for the
  // Pro entitlement, so its locked state sells Pro (a Pro badge and the buy
  // button) instead of linking to the tester application.
];

/**
 * A locked beta control has to look locked. A disabled toggle whose only
 * explanation sits in small description text reads as a bug in the app, and
 * the app previously used three different words for the same state: "Beta" in
 * the sidebar, "Tester" on page headers, "Approved testers only" on one page.
 */
describe("beta feature labelling", () => {
  it("labels gated dictation enhancement without locking public coding prompts", () => {
    const source = readSource("src/components/pages/AIEnhancementPage.tsx");
    expect(source).toContain('isFeatureUnlocked("ai-enhancement")');
    expect(source).toMatch(
      /!isUnlocked && \([\s\S]*?Dictation enhancement is in beta[\s\S]*?<BetaAccessLink/
    );
    expect(source).toContain("{isUnlocked && (");
    expect(source).toContain("{!isUnlocked && <CodingPromptSettings />}");
    expect(source).not.toContain("<BetaBadge");
  });

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

    // Smart Context is the one toggle left in Settings that sits disabled for
    // everyone without tester access. Correction Memory's toggles live on its
    // own page under Dictionary now, badged there.
    expect(settings).toContain("badge={smartContextUnlocked ? undefined : <BetaBadge locked />}");
    expect(readSource("src/components/pages/CorrectionMemoryPage.tsx")).toContain(
      "<BetaBadge locked={!isUnlocked} />"
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
    // One locked toggle left in Settings: Smart Context, in General. It was
    // four until Read Aloud left Settings for its own sidebar page, three until
    // the unreachable "aiModels" case was deleted, and two until Correction
    // Memory's toggles moved onto their own page under Dictionary, which is
    // checked above.
    expect(settings.match(/<BetaAccessLink/g) ?? []).toHaveLength(1);
  });

  it("keeps the beta destination in one place", () => {
    const links = readSource("src/utils/externalLinks.ts");
    expect(links).toContain("BETA_ACCESS_URL");

    // The site has no /beta route. #waitlist is the tester section itself,
    // rather than #pricing, which drops the user on the purchase cards and
    // leaves them to find the beta story below.
    expect(links).not.toContain("privatetranscribe.com/beta");
    expect(links).toContain("#waitlist");

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
