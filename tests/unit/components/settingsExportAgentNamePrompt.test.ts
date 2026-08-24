import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// SettingsPage.tsx's buildSettingsExport/applyImportedSettings are React
// callbacks wired to a dozen other hooks (useSettings, useDialogs, etc).
// There's no React Testing Library in this repo (see the Vitest CJS mocking
// limit note), so — matching the existing convention for this file
// (settingsProductionTabs.test.ts, settingsTranscriptionModelPropagation.test.ts)
// — these assertions read the real source and check the exact behavior
// contract rather than mocking the component tree.
const readSettingsPage = () =>
  fs.readFileSync(path.join(process.cwd(), "src", "components", "SettingsPage.tsx"), "utf8");

describe("Settings export/import: agentName and customUnifiedPrompt", () => {
  it("exports the raw stored agentName (not the default) and customUnifiedPrompt, decoded", () => {
    const contents = readSettingsPage();
    const exportBlock =
      contents.split("const buildSettingsExport =")[1]?.split("const downloadSettings =")[0] ??
      "";

    // Reads raw localStorage, not getAgentName()/useAgentName() (which would
    // fall back to the "PrivateTranscribe" default and stamp it onto a
    // machine that never had a custom name set).
    expect(exportBlock).toContain('localStorage.getItem(AGENT_NAME_STORAGE_KEY)');
    expect(exportBlock).not.toContain("getAgentName()");

    // Both fields are omitted (not set to null/default) when unset.
    expect(exportBlock).toContain("if (rawAgentName !== null)");
    expect(exportBlock).toContain("payload.settings.agentName = rawAgentName");
    expect(exportBlock).toContain("readStoredCustomPrompt()");
    expect(exportBlock).toContain("if (storedCustomPrompt !== undefined)");
    expect(exportBlock).toContain("payload.settings.customUnifiedPrompt = storedCustomPrompt");
  });

  it("decodes customUnifiedPrompt the same way PromptStudio's getCurrentPrompt() does", () => {
    const contents = readSettingsPage();
    const decodeBlock =
      contents.split("const readStoredCustomPrompt")[1]?.split("interface SettingsPageProps")[0] ??
      "";

    expect(decodeBlock).toContain('localStorage.getItem(CUSTOM_PROMPT_STORAGE_KEY)');
    expect(decodeBlock).toContain("JSON.parse(raw)");
    // Corrupt/non-string stored data is treated as absent, not exported raw.
    expect(decodeBlock).toContain('typeof parsed === "string" ? parsed : undefined');
  });

  it("validates agentName on import: non-empty, path-safe, length-capped, written via setAgentName", () => {
    const contents = readSettingsPage();
    const importBlock =
      contents.split("// agentName and customUnifiedPrompt are absent from older export files")[1]
        ?.split("if (allowApiKeysOnImport)")[0] ?? "";

    expect(importBlock).toContain("if (s.agentName !== undefined)");
    expect(importBlock).toContain("isSafeImportedIdentifier(trimmedAgentName)");
    expect(importBlock).toContain("trimmedAgentName.length <= AGENT_NAME_MAX_LENGTH");
    expect(importBlock).toContain("persistAgentName(trimmedAgentName)");
    expect(importBlock).toMatch(/skipField\(\s*"agentName"/);
  });

  it("validates customUnifiedPrompt on import: string type, length-capped, written the way PromptStudio reads it", () => {
    const contents = readSettingsPage();
    const importBlock =
      contents.split("// agentName and customUnifiedPrompt are absent from older export files")[1]
        ?.split("if (allowApiKeysOnImport)")[0] ?? "";

    expect(importBlock).toContain("if (s.customUnifiedPrompt !== undefined)");
    expect(importBlock).toContain('typeof s.customUnifiedPrompt === "string"');
    expect(importBlock).toContain("s.customUnifiedPrompt.length <= CUSTOM_PROMPT_MAX_LENGTH");
    expect(importBlock).toContain(
      "localStorage.setItem(CUSTOM_PROMPT_STORAGE_KEY, JSON.stringify(s.customUnifiedPrompt))"
    );
    expect(importBlock).toMatch(/skipField\(\s*"customUnifiedPrompt"/);
  });

  it("does not clear agentName/customUnifiedPrompt when the keys are absent from an older export (backward compat)", () => {
    const contents = readSettingsPage();
    const importBlock =
      contents.split("// agentName and customUnifiedPrompt are absent from older export files")[1]
        ?.split("if (allowApiKeysOnImport)")[0] ?? "";

    // Both blocks are gated on `!== undefined` with no else branch that
    // clears/resets the stored value — an absent key is a pure no-op.
    expect(importBlock).toContain("if (s.agentName !== undefined) {");
    expect(importBlock).toContain("if (s.customUnifiedPrompt !== undefined) {");
    expect(importBlock).not.toContain("clearAgentName()");
    expect(importBlock).not.toContain('localStorage.removeItem(CUSTOM_PROMPT_STORAGE_KEY)');
  });

  it("imports the module's real setAgentName so the change event fires for mounted listeners", () => {
    const contents = readSettingsPage();
    expect(contents).toContain(
      'import { setAgentName as persistAgentName } from "../utils/agentName";'
    );
  });
});
