"use strict";

const TERMINAL_PROCESS_NAMES = new Set([
  "alacritty",
  "cmd",
  "cmder",
  "conemu",
  "conemu64",
  "console",
  "consolez",
  "conhost",
  "fluentterminal",
  "ghostty",
  "hyper",
  "kitty",
  "mintty",
  "powershell",
  "pwsh",
  "tabby",
  "terminus",
  "warp",
  "wezterm",
  "wezterm-gui",
  "windowsterminal",
  "wt",
]);

function normalizeProcessName(processName) {
  return String(processName || "")
    .trim()
    .toLowerCase()
    .replace(/\.exe$/i, "");
}

function isWindowsTerminalTarget({ processName = "", focusLooksLikeTerminal = false } = {}) {
  if (TERMINAL_PROCESS_NAMES.has(normalizeProcessName(processName))) {
    return true;
  }

  // Electron-based editors such as VS Code and Cursor own both their editor and
  // integrated terminal windows. UI Automation exposes terminal-specific focus
  // metadata (for example, "Terminal input" or "xterm-helper-textarea"). The
  // detector reduces that metadata to a boolean before returning it here.
  return focusLooksLikeTerminal === true;
}

function getWindowsPasteShortcut(target = {}) {
  const isTerminal = isWindowsTerminalTarget(target);
  return isTerminal
    ? { isTerminal: true, nircmdKeys: "ctrl+shift+v", sendKeys: "^+v" }
    : { isTerminal: false, nircmdKeys: "ctrl+v", sendKeys: "^v" };
}

// The script returns only the process name and a terminal/not-terminal boolean.
// It does not read the focused control's value or any clipboard/transcript text.
const WINDOWS_PASTE_TARGET_SCRIPT = `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PasteTargetWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

$processName = ""
$focusLooksLikeTerminal = $false

try {
  $window = [PasteTargetWin32]::GetForegroundWindow()
  $processId = 0
  [void][PasteTargetWin32]::GetWindowThreadProcessId($window, [ref]$processId)
  $processName = (Get-Process -Id $processId -ErrorAction Stop).ProcessName
} catch {}

try {
  Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
  $element = [System.Windows.Automation.AutomationElement]::FocusedElement
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

  for ($depth = 0; $element -ne $null -and $depth -lt 7; $depth++) {
    $structuralMetadata = @(
      $element.Current.AutomationId,
      $element.Current.ClassName,
      $element.Current.ControlType.ProgrammaticName
    ) -join ' '
    $name = [string]$element.Current.Name

    if ($structuralMetadata -match '(^|[\\s._-])(terminal|xterm|console)($|[\\s._-])' -or
        $name -match '^(terminal|terminal input)(:|$)' -or
        $name -match 'xterm') {
      $focusLooksLikeTerminal = $true
      break
    }
    $element = $walker.GetParent($element)
  }
} catch {}

[pscustomobject]@{
  processName = $processName
  focusLooksLikeTerminal = $focusLooksLikeTerminal
} | ConvertTo-Json -Compress`;

module.exports = {
  WINDOWS_PASTE_TARGET_SCRIPT,
  getWindowsPasteShortcut,
  isWindowsTerminalTarget,
};
