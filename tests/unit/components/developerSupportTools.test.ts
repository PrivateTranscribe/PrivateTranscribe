import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Settings support and diagnostics tools", () => {
  it("does not access Node process directly from the renderer support buttons", () => {
    const developerSection = fs.readFileSync(
      path.join(process.cwd(), "src", "components", "DeveloperSection.tsx"),
      "utf8"
    );

    expect(developerSection).not.toContain("process?.versions");
    expect(developerSection).toContain("getRuntimeVersions");
  });

  it("preload exposes runtime versions through the safe electron bridge", () => {
    const preload = fs.readFileSync(path.join(process.cwd(), "preload.js"), "utf8");

    expect(preload).toContain("getRuntimeVersions: () => ({");
    expect(preload).toContain("electron: process.versions.electron");
  });

  it("Help & Support includes an explicit tester feedback action", () => {
    const settingsPage = fs.readFileSync(
      path.join(process.cwd(), "src", "components", "SettingsPage.tsx"),
      "utf8"
    );

    expect(settingsPage).toContain("Contact & Feedback");
    expect(settingsPage).toContain("Draft Feedback Email");
    expect(settingsPage).toContain("PrivateTranscribe feedback");
    expect(settingsPage).toContain("Nothing is sent automatically");
  });

  it("formats the app version object instead of rendering [object Object]", () => {
    const developerSection = fs.readFileSync(
      path.join(process.cwd(), "src", "components", "DeveloperSection.tsx"),
      "utf8"
    );

    expect(developerSection).toContain("versionResult?.version || \"unknown\"");
    expect(developerSection).toContain("PrivateTranscribe v${version}");
  });

  it("the diagnostics section is labeled for users, not only developers", () => {
    const settingsModal = fs.readFileSync(
      path.join(process.cwd(), "src", "components", "SettingsModal.tsx"),
      "utf8"
    );
    const settingsPage = fs.readFileSync(
      path.join(process.cwd(), "src", "components", "SettingsPage.tsx"),
      "utf8"
    );

    expect(settingsModal).toContain('label: "Diagnostics & Data"');
    expect(settingsPage).toContain('title="Diagnostics & Data"');
  });
});
