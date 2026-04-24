import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

describe("Analytics consent flow regression checks", () => {
  it("ControlPanelShell requests consent status and conditionally renders the consent modal", () => {
    const shellPath = path.join(process.cwd(), "src", "components", "ControlPanelShell.tsx");
    const contents = fs.readFileSync(shellPath, "utf8");

    expect(contents).toContain("analyticsNeedsConsent");
    expect(contents).toContain("if (needs) setShowConsentModal(true)");
    expect(contents).toContain("{showConsentModal && <AnalyticsConsentModal");
  });

  it("AnalyticsConsentModal persists the user choice through electronAPI", () => {
    const modalPath = path.join(process.cwd(), "src", "components", "AnalyticsConsentModal.jsx");
    const contents = fs.readFileSync(modalPath, "utf8");

    expect(contents).toContain("analyticsSetConsent");
    expect(contents).toContain("onConsent(granted)");
    expect(contents).toContain("No audio, no text, ever.");
  });

  it("preload and ipc handlers expose the analytics consent bridge", () => {
    const preloadPath = path.join(process.cwd(), "preload.js");
    const ipcPath = path.join(process.cwd(), "src", "helpers", "ipcHandlers.js");

    const preload = fs.readFileSync(preloadPath, "utf8");
    const ipcHandlers = fs.readFileSync(ipcPath, "utf8");

    expect(preload).toContain('analyticsNeedsConsent: () => ipcRenderer.invoke("analytics-needs-consent")');
    expect(preload).toContain('analyticsSetConsent: (granted) => ipcRenderer.invoke("analytics-set-consent", granted)');
    expect(ipcHandlers).toContain('ipcMain.handle("analytics-needs-consent"');
    expect(ipcHandlers).toContain('ipcMain.handle("analytics-set-consent"');
  });
});
