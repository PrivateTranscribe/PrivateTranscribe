import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const readSource = (relativePath: string) =>
  fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

describe("Settings production tabs", () => {
  it("does not label the production data-management tab as Developer", () => {
    const wrapper = readSource("src/components/pages/SettingsPageWrapper.tsx");

    expect(wrapper).toContain("getSettingsTabs");
    expect(wrapper).toContain('import.meta.env.DEV ? "Developer" : "Data & Storage"');
  });

  it("does not render an empty Diagnostics section in production", () => {
    const settingsPage = readSource("src/components/SettingsPage.tsx");

    expect(settingsPage).toContain("const showDeveloperDiagnostics = updateStatus.isDevelopment");
    expect(settingsPage).toContain("showDeveloperDiagnostics && <DeveloperSection />");
    expect(settingsPage).toContain('title={showDeveloperDiagnostics ? "Diagnostics & Data" : "Data & Storage"}');
    expect(settingsPage).toContain('className={showDeveloperDiagnostics ? "border-t border-border/30 pt-8" : ""}');
  });
});
