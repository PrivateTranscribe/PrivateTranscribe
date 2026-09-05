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
  it("renders the four Agent Mode rows on the settings page", () => {
    const page = read("src", "components", "SettingsPage.tsx");

    expect(page).toContain('label="Agent Mode"');
    expect(page).toContain('label="Agent Mode hotkey"');
    expect(page).toContain('label="Rewrite with Claude Code"');
    expect(page).toContain('label="Prompts today"');
  });

  it("re-syncs the main process and reads the live daily count", () => {
    const page = read("src", "components", "SettingsPage.tsx");

    expect(page).toContain("agentModeSyncHotkey");
    expect(page).toContain("agentModeHotkeyStatus");
    expect(page).toContain("readAgentModeUsage");
    expect(page).toContain("Everything runs on this PC. No text leaves it.");
  });

  it("asks the main process whether Claude Code is there and says so honestly", () => {
    const page = read("src", "components", "SettingsPage.tsx");

    expect(page).toContain("agentModeRewriteStatus");
    expect(page).toContain(
      "Claude Code was not found on this PC. Prompts are pasted as spoken, with paths in backticks."
    );
    expect(page).toContain(
      "Your words go through your own Claude Code login before they are pasted. Nothing else leaves this PC."
    );
    expect(page).toContain(
      "The rewrite goes through your Claude Code login. Everything else runs on this PC."
    );
  });

  it("stores the settings with the defaults the overlay reads raw", () => {
    const hook = read("src", "hooks", "useSettings.ts");

    expect(hook).toMatch(/useLocalStorage\(\s*"agentModeEnabled",\s*true,/);
    expect(hook).toMatch(/useLocalStorage\(\s*"agentModeHotkey",\s*DEFAULT_AGENT_MODE_HOTKEY,/);
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

    expect(exportBlock).toContain("agentModeEnabled,");
    expect(exportBlock).toContain("agentModeHotkey,");
    expect(exportBlock).toContain("agentModeRewrite,");
    expect(page).toContain("setAgentModeEnabled(s.agentModeEnabled)");
    expect(page).toContain("setAgentModeHotkey(s.agentModeHotkey)");
    expect(page).toContain("setAgentModeRewrite(s.agentModeRewrite)");
  });
});
