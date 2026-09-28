/**
 * The Agent Mode section is hand-wired across four files: the settings hook
 * stores the two keys, the settings page renders them and re-syncs the main
 * process, and the hotkey list decides which keys the picker offers. Nothing
 * at runtime ties those together, so this reads the sources back and fails
 * when one half moves without the other.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_MODE_HOTKEY_OPTIONS, DEFAULT_AGENT_MODE_HOTKEY } from "../../../src/utils/hotkeys";

const read = (...segments: string[]) =>
  fs.readFileSync(path.join(process.cwd(), ...segments), "utf8");

describe("Agent Mode settings wiring", () => {
  it("renders the three Agent Mode rows on the settings page, with no daily count", () => {
    const page = read("src", "components", "CodingPromptSettings.tsx");

    expect(page).toContain('label="Enable agent mode"');
    expect(page).not.toContain('label="Coding prompt hotkey"');
    expect(page).toContain('label="Agent mode AI connection"');
    expect(page).toContain('label="Enhance coding prompts"');
    expect(page).not.toContain('label="Prompts today"');
  });

  it("re-reads the Claude Code status whenever the window comes back", () => {
    const page = read("src", "components", "CodingPromptSettings.tsx");

    expect(page).not.toContain("agentModeSyncHotkey");
    expect(page).not.toContain("agentModeHotkeyStatus");
    expect(page).not.toContain("readAgentModeUsage");
    expect(page).toContain('window.addEventListener("focus", refreshRewriteStatus)');
  });

  it("points a locked shared connection at the beta features switch", () => {
    const page = read("src", "components", "CodingPromptSettings.tsx");

    expect(page).toContain('from "../utils/betaFeatures"');
    expect(page).toContain("Turn on beta features in Settings to use the shared connection.");
    expect(page).not.toContain("tester access");
  });

  it("asks the main process whether Claude Code is there and says so honestly", () => {
    const page = read("src", "components", "CodingPromptSettings.tsx");

    expect(page).toContain("agentModeRewriteStatus");
    expect(page).toContain(
      "Claude Code was not found on this PC. Prompts are pasted as spoken, with paths in backticks."
    );
    expect(page).toContain("Rewrites prompts through your Claude Code login before pasting.");
    expect(page).toContain("Rewriting sends text through your Claude Code login.");
    expect(page).toContain("Audio is transcribed on this PC.");
    expect(page).toContain("Audio is sent to your selected transcription service.");
  });

  it("stores the settings with the defaults the overlay reads raw", () => {
    const hook = read("src", "hooks", "useSettings.ts");

    expect(hook).toMatch(/useLocalStorage\(\s*"agentModeDictationEnabled",\s*false,/);
    expect(hook).not.toContain('"agentModeHotkey"');
    expect(hook).toMatch(/useLocalStorage\(\s*"agentModeRewrite",\s*true,/);
  });

  it("defaults to the key the main process defaults to", () => {
    expect(DEFAULT_AGENT_MODE_HOTKEY).toBe("RightControl");
    expect(read("src", "helpers", "agentModeHotkey.js")).toContain(
      'const DEFAULT_AGENT_MODE_HOTKEY = "RightControl"'
    );
  });

  it("offers no key an editor or a typing hand already owns", () => {
    const values = AGENT_MODE_HOTKEY_OPTIONS.map((option) => option.value);

    expect(values).toContain("RightControl");
    expect(values).not.toContain("F11");
    expect(values).not.toContain("F12");
    expect(values).not.toContain("LeftControl");
    expect(values).not.toContain("LeftAlt");
  });

  it("carries all three settings through settings export", () => {
    const page = read("src", "components", "SettingsPage.tsx");
    const exportBlock = page.slice(
      page.indexOf("// Agent Mode"),
      page.indexOf("// Devices", page.indexOf("// Agent Mode"))
    );

    expect(exportBlock).toContain("agentModeDictationEnabled: agentModeEnabled,");
    expect(exportBlock).not.toContain("agentModeHotkey,");
    expect(exportBlock).toContain("agentModeRewrite,");
    expect(page).toContain("setAgentModeEnabled(s.agentModeDictationEnabled)");
    expect(page).not.toContain("setAgentModeHotkey(s.agentModeHotkey)");
    expect(page).toContain("setAgentModeRewrite(s.agentModeRewrite)");
  });
});
