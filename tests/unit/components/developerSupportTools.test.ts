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

    expect(appSidebar).toContain("buildLabel");
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

    expect(preload).toContain(
      'submitFeedback: (payload) => ipcRenderer.invoke("submit-feedback", payload)'
    );
    expect(ipcHandlers).toContain('ipcMain.handle("submit-feedback"');
    expect(ipcHandlers).toContain("getDeviceIdForExplicitFeedback");
    expect(ipcHandlers).toContain("/functions/v1/feedback");
    expect(ipcHandlers).not.toContain("PRIVATE_TRANSCRIBE_FEEDBACK_TOKEN");
    expect(electronTypes).toContain("submitFeedback");
  });

  it("feedback dialog keeps early-user feedback simple and backend-aligned", () => {
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

    const feedbackPayloadType =
      electronTypes.match(/export interface FeedbackSubmitPayload[\s\S]*?\n}/)?.[0] ?? "";
    expect(feedbackPayloadType).toContain("export interface FeedbackSubmitPayload");

    for (const value of ["bug", "confusing", "feature", "general"]) {
      expect(feedbackDialog).toContain(`value: "${value}"`);
      expect(ipcHandlers).toContain(`"${value}"`);
      expect(feedbackPayloadType).toContain(`"${value}"`);
    }

    for (const oldValue of ["install", "onboarding", "transcription", "hotkey", "performance"]) {
      expect(feedbackDialog).not.toContain(`value: "${oldValue}"`);
      expect(ipcHandlers).not.toContain(`"${oldValue}"`);
      expect(feedbackPayloadType).not.toContain(`"${oldValue}"`);
    }

    expect(feedbackDialog).toContain("Your note");
    expect(feedbackDialog).toContain("Type");
    expect(feedbackDialog).toContain("No email app required");
    expect(feedbackDialog).toContain("hardware specs (CPU, GPU, RAM)");
    expect(feedbackDialog).toContain("Attach screenshots");
    expect(feedbackDialog).toContain("MAX_ATTACHMENTS");
    expect(feedbackDialog).toContain("FileReader");
    expect(feedbackDialog).toContain("handlePastedImages");
    expect(feedbackDialog).toContain("onPaste={handlePastedImages}");
    expect(feedbackDialog).toContain("Paste screenshots here or use Add image");
    expect(feedbackDialog).toContain("src={attachment.dataUrl}");
    expect(feedbackDialog).toContain("Preview of ${attachment.name}");
    expect(feedbackDialog).toContain("object-cover");
    expect(feedbackDialog).toContain("setAttachmentError");
    expect(feedbackDialog).not.toContain("includeSystemInfo");
    expect(ipcHandlers).toContain("systemInfo: {");
    expect(ipcHandlers).toContain("app.getVersion()");
    expect(ipcHandlers).toContain("sanitizeFeedbackAttachments");
    expect(ipcHandlers).not.toContain("payload.includeSystemInfo");
    expect(electronTypes).toContain("FeedbackAttachmentPayload");
    expect(electronTypes).not.toContain("includeSystemInfo");
    expect(feedbackDialog).not.toContain("Quick tester templates");
  });

  it("feedback backend stores screenshot attachments and forwards links to Discord", () => {
    const feedbackFunction = fs.readFileSync(
      path.join(process.cwd(), "supabase", "functions", "feedback", "index.ts"),
      "utf8"
    );
    const attachmentMigration = fs.readFileSync(
      path.join(
        process.cwd(),
        "supabase",
        "migrations",
        "202606230001_add_feedback_attachments.sql"
      ),
      "utf8"
    );

    expect(feedbackFunction).toContain("FEEDBACK_ATTACHMENT_BUCKET");
    expect(feedbackFunction).toContain("uploadFeedbackAttachments");
    expect(feedbackFunction).toContain("createSignedUrl");
    expect(feedbackFunction).toContain("Attachment");
    expect(feedbackFunction).toContain("feature: 0x38bdf8");
    expect(feedbackFunction).toContain("general: 0x8b5cf6");
    expect(attachmentMigration).toContain("feedback-attachments");
    expect(attachmentMigration).toContain("attachments jsonb");
  });

  it("formats the app version object instead of rendering [object Object]", () => {
    const developerSection = fs.readFileSync(
      path.join(process.cwd(), "src", "components", "DeveloperSection.tsx"),
      "utf8"
    );

    expect(developerSection).toContain('versionResult?.version || "unknown"');
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

  it("keeps diagnostics labeled for dev while production shows data storage", () => {
    const settingsPage = fs.readFileSync(
      path.join(process.cwd(), "src", "components", "SettingsPage.tsx"),
      "utf8"
    );

    expect(settingsPage).toContain('"Diagnostics & Data"');
    expect(settingsPage).toContain('"Data & Storage"');
    expect(settingsPage).toContain("showDeveloperDiagnostics");
  });
});
