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
    expect(settingsPage).toContain("Send Feedback");
    expect(settingsPage).toContain("In-app feedback");
    expect(settingsPage).toContain("No email app required");
  });

  it("shows early access feedback prominently in the main sidebar footer", () => {
    const appSidebar = fs.readFileSync(
      path.join(process.cwd(), "src", "components", "AppSidebar.tsx"),
      "utf8"
    );

    expect(appSidebar).toContain("Early access");
    expect(appSidebar).toContain("Send Feedback");
    expect(appSidebar).toContain("FeedbackDialog");
  });

  it("submits in-app feedback through a safe preload IPC bridge", () => {
    const preload = fs.readFileSync(path.join(process.cwd(), "preload.js"), "utf8");
    const ipcHandlers = fs.readFileSync(
      path.join(process.cwd(), "src", "helpers", "ipcHandlers.js"),
      "utf8"
    );
    const electronTypes = fs.readFileSync(
      path.join(process.cwd(), "src", "types", "electron.ts"),
      "utf8"
    );

    expect(preload).toContain("submitFeedback: (payload) => ipcRenderer.invoke(\"submit-feedback\", payload)");
    expect(ipcHandlers).toContain('ipcMain.handle("submit-feedback"');
    expect(ipcHandlers).toContain("getDeviceIdForExplicitFeedback");
    expect(ipcHandlers).toContain("/functions/v1/feedback");
    expect(ipcHandlers).not.toContain("PRIVATE_TRANSCRIBE_FEEDBACK_TOKEN");
    expect(electronTypes).toContain("submitFeedback");
  });

  it("feedback dialog collects structured launch tester evidence", () => {
    const feedbackDialog = fs.readFileSync(
      path.join(process.cwd(), "src", "components", "FeedbackDialog.tsx"),
      "utf8"
    );
    const ipcHandlers = fs.readFileSync(
      path.join(process.cwd(), "src", "helpers", "ipcHandlers.js"),
      "utf8"
    );
    const electronTypes = fs.readFileSync(
      path.join(process.cwd(), "src", "types", "electron.ts"),
      "utf8"
    );

    for (const value of ["install", "onboarding", "transcription", "hotkey", "performance"]) {
      expect(feedbackDialog).toContain(`value: "${value}"`);
      expect(ipcHandlers).toContain(`"${value}"`);
      expect(electronTypes).toContain(`| "${value}"`);
    }

    expect(feedbackDialog).toContain("Quick tester templates");
    expect(feedbackDialog).toContain("Install failed");
    expect(feedbackDialog).toContain("First dictation failed");
    expect(feedbackDialog).toContain("Did SmartScreen appear? yes/no");
    expect(feedbackDialog).toContain("Would you use this again tomorrow? yes/no");
  });

  it("formats the app version object instead of rendering [object Object]", () => {
    const developerSection = fs.readFileSync(
      path.join(process.cwd(), "src", "components", "DeveloperSection.tsx"),
      "utf8"
    );

    expect(developerSection).toContain("versionResult?.version || \"unknown\"");
    expect(developerSection).toContain("PrivateTranscribe v${version}");
  });

  it("feedback backend hashes device identity and rate-limits per device", () => {
    const feedbackFunction = fs.readFileSync(
      path.join(process.cwd(), "supabase", "functions", "feedback", "index.ts"),
      "utf8"
    );
    const rateLimitMigration = fs.readFileSync(
      path.join(
        process.cwd(),
        "supabase",
        "migrations",
        "202606030002_add_feedback_device_rate_limit_key.sql"
      ),
      "utf8"
    );

    expect(feedbackFunction).toContain("FEEDBACK_PER_DEVICE_PER_HOUR = 100");
    expect(feedbackFunction).toContain("sha256Hex(deviceId)");
    expect(feedbackFunction).toContain("status: 429");
    expect(rateLimitMigration).toContain("device_id_hash");
    expect(rateLimitMigration).toContain("feedback_device_id_hash_created_at_idx");
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
