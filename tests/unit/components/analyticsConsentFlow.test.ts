import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

describe("Analytics consent flow regression checks", () => {
  it("requests consent before first-run onboarding and keeps a dashboard fallback", () => {
    const routerPath = path.join(process.cwd(), "src", "main.jsx");
    const shellPath = path.join(process.cwd(), "src", "components", "ControlPanelShell.tsx");
    const router = fs.readFileSync(routerPath, "utf8");
    const contents = fs.readFileSync(shellPath, "utf8");

    expect(router).toContain("showAnalyticsConsent");
    expect(router).toContain("<OnboardingFlow");
    expect(router).toContain("<AnalyticsConsentModal");
    expect(router).toContain('"onboarding_started"');
    expect(contents).toContain("analyticsNeedsConsent");
    expect(contents).toContain("if (needs) setShowConsentModal(true)");
    expect(contents).toContain("{showConsentModal && <AnalyticsConsentModal");
  });

  it("AnalyticsConsentModal persists the user choice through electronAPI", () => {
    const modalPath = path.join(process.cwd(), "src", "components", "AnalyticsConsentModal.jsx");
    const contents = fs.readFileSync(modalPath, "utf8");

    expect(contents).toContain("analyticsSetConsent");
    expect(contents).toContain("onConsent(granted)");
    expect(contents).toContain("never sends");
    expect(contents).toContain("audio, transcripts, window titles, filenames, or API keys");
  });

  it("preload and ipc handlers expose the analytics consent bridge", () => {
    const preloadPath = path.join(process.cwd(), "preload.js");
    const ipcPath = path.join(process.cwd(), "src", "helpers", "ipcHandlers.js");

    const preload = fs.readFileSync(preloadPath, "utf8");
    const ipcHandlers = fs.readFileSync(ipcPath, "utf8");

    expect(preload).toContain(
      'analyticsNeedsConsent: () => ipcRenderer.invoke("analytics-needs-consent")'
    );
    expect(preload).toContain(
      'analyticsGetConsent: () => ipcRenderer.invoke("analytics-get-consent")'
    );
    expect(preload).toContain(
      'analyticsSetConsent: (granted) => ipcRenderer.invoke("analytics-set-consent", granted)'
    );
    expect(ipcHandlers).toContain('ipcMain.handle("analytics-needs-consent"');
    expect(ipcHandlers).toContain('ipcMain.handle("analytics-get-consent"');
    expect(ipcHandlers).toContain('ipcMain.handle("analytics-set-consent"');
  });

  it("lets users withdraw or restore analytics consent from Privacy settings", () => {
    const settingsPath = path.join(process.cwd(), "src", "components", "SettingsPage.tsx");
    const contents = fs.readFileSync(settingsPath, "utf8");

    expect(contents).toContain("Anonymous usage analytics");
    expect(contents).toContain("analyticsGetConsent");
    expect(contents).toContain("handleAnalyticsEnabledChange");
    expect(contents).toContain("analyticsSetConsent");
  });
});
