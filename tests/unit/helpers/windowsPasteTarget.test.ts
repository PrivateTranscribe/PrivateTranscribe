import { describe, expect, test } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  WINDOWS_PASTE_TARGET_SCRIPT,
  getWindowsPasteShortcut,
  isWindowsTerminalTarget,
} = require("../../../src/helpers/windowsPasteTarget");

describe("Windows paste target routing", () => {
  test.each([
    "WindowsTerminal.exe",
    "pwsh",
    "powershell.exe",
    "cmd.exe",
    "conhost.exe",
    "wezterm-gui.exe",
    "alacritty.exe",
    "mintty.exe",
  ])("recognizes standalone terminal host %s", (processName) => {
    expect(isWindowsTerminalTarget({ processName })).toBe(true);
  });

  test("recognizes an integrated terminal from focused UI Automation metadata", () => {
    expect(
      isWindowsTerminalTarget({
        processName: "Code.exe",
        focusLooksLikeTerminal: true,
      })
    ).toBe(true);

    expect(
      isWindowsTerminalTarget({
        processName: "Cursor.exe",
        focusLooksLikeTerminal: true,
      })
    ).toBe(true);
  });

  test("does not treat normal editor or document fields as terminals", () => {
    expect(
      isWindowsTerminalTarget({
        processName: "Code.exe",
        windowTitle: "clipboard.js - PrivateTranscribe - Visual Studio Code",
        focusLooksLikeTerminal: false,
      })
    ).toBe(false);
    expect(isWindowsTerminalTarget({ processName: "notepad.exe" })).toBe(false);
    expect(isWindowsTerminalTarget({ processName: "WINWORD.EXE" })).toBe(false);
  });

  test("keeps target detection metadata-only", () => {
    expect(WINDOWS_PASTE_TARGET_SCRIPT).toContain("focusLooksLikeTerminal");
    expect(WINDOWS_PASTE_TARGET_SCRIPT).not.toContain("ValuePattern");
    expect(WINDOWS_PASTE_TARGET_SCRIPT).not.toContain("TextPattern");
    expect(WINDOWS_PASTE_TARGET_SCRIPT).not.toContain("Clipboard");
  });

  test("uses the terminal-owned paste chord only for terminal targets", () => {
    expect(getWindowsPasteShortcut({ processName: "WindowsTerminal.exe" })).toEqual({
      isTerminal: true,
      nircmdKeys: "ctrl+shift+v",
      sendKeys: "^+v",
    });

    expect(getWindowsPasteShortcut({ processName: "notepad.exe" })).toEqual({
      isTerminal: false,
      nircmdKeys: "ctrl+v",
      sendKeys: "^v",
    });
  });
});
