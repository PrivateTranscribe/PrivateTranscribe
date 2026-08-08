import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("Pro branding", () => {
  it("uses the same purple Pro accent as the website in the settings Pro section", () => {
    const source = readSource("src/components/ProSettingsSection.tsx");

    expect(source).toContain("#A885FF");
    expect(source).toContain("#2D1B69");
    expect(source).not.toContain("validated automatically when online");
    expect(source).toContain(
      "Unlimited private dictation unlocked with your one-time Pro purchase"
    );
    expect(source).not.toContain("border-green-500/30");
    expect(source).not.toContain("bg-green-500/5");
    expect(source).not.toContain("text-green-500");
  });

  it("keeps page and sidebar Pro badges purple", () => {
    const files = [
      "src/components/AppSidebar.tsx",
      "src/components/pages/AIEnhancementPage.tsx",
      "src/components/pages/VoiceAssistantPage.tsx",
      "src/components/pages/ActionEnginePage.tsx",
    ];

    for (const file of files) {
      const source = readSource(file);
      expect(source, file).toContain("#A885FF");
    }
  });
});
