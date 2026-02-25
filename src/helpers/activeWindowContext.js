"use strict";

const { spawnSync } = require("child_process");
const { sanitizeContextText } = require("./contextSanitizer");

function run(cmd, args) {
  try {
    const res = spawnSync(cmd, args, { encoding: "utf8" });
    return {
      ok: res.status === 0,
      status: res.status,
      stdout: (res.stdout || "").toString(),
      stderr: (res.stderr || "").toString(),
    };
  } catch (error) {
    return { ok: false, status: null, stdout: "", stderr: error?.message || String(error) };
  }
}

function commandExists(cmd) {
  // No shell, no paths, no metacharacters.
  if (!/^[a-zA-Z0-9_-]+$/.test(cmd)) return false;
  const res = run("which", [cmd]);
  return res.ok;
}

function getLinuxXdotoolContext() {
  if (!commandExists("xdotool")) {
    return { available: false, reason: "xdotool not installed" };
  }

  const activeWin = run("xdotool", ["getactivewindow"]);
  if (!activeWin.ok) {
    return { available: false, reason: "xdotool getactivewindow failed" };
  }
  const windowId = (activeWin.stdout || "").trim();
  if (!windowId) {
    return { available: false, reason: "no active window id" };
  }

  const nameRes = run("xdotool", ["getwindowname", windowId]);
  const classRes = run("xdotool", ["getwindowclassname", windowId]);

  const windowTitle = sanitizeContextText((nameRes.stdout || "").trim(), { maxChars: 512 });
  const appClass = sanitizeContextText((classRes.stdout || "").trim(), { maxChars: 128 });

  if (!windowTitle && !appClass) {
    return { available: false, reason: "no window title/class" };
  }

  return {
    available: true,
    platform: "linux",
    method: "xdotool",
    windowId,
    windowTitle,
    appClass,
  };
}

function getMacOSContext() {
  // Requires Accessibility. If unavailable, osascript will fail.
  const script = [
    'tell application "System Events"',
    "set frontApp to name of first application process whose frontmost is true",
    "set frontWin to \"\"",
    "try",
    "set frontWin to name of front window of (first application process whose frontmost is true)",
    "end try",
    "return frontApp & \"\n\" & frontWin",
    "end tell",
  ].join("\n");

  const res = run("osascript", ["-e", script]);
  if (!res.ok) {
    return { available: false, reason: "osascript failed (likely missing Accessibility permission)" };
  }

  const [appNameRaw, winRaw] = (res.stdout || "").split("\n");
  const appName = sanitizeContextText((appNameRaw || "").trim(), { maxChars: 128 });
  const windowTitle = sanitizeContextText((winRaw || "").trim(), { maxChars: 512 });

  if (!appName && !windowTitle) {
    return { available: false, reason: "no frontmost app/window" };
  }

  return {
    available: true,
    platform: "darwin",
    method: "osascript",
    appName,
    windowTitle,
  };
}

function getWindowsContext() {
  // PowerShell: get foreground window title + owning process name.
  // Note: This may be blocked by AV or policy in some environments.
  const ps = `Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();
  [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@;
$h = [Win32]::GetForegroundWindow();
$sb = New-Object System.Text.StringBuilder 1024;
[void][Win32]::GetWindowText($h, $sb, $sb.Capacity);
$pid = 0;
[void][Win32]::GetWindowThreadProcessId($h, [ref]$pid);
$pname = "";
try { $pname = (Get-Process -Id $pid -ErrorAction Stop).ProcessName } catch { $pname = "" }
$sb.ToString();
$pname;`;

  const res = run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-Command",
    ps,
  ]);

  if (!res.ok) {
    return { available: false, reason: "powershell foreground query failed" };
  }

  const lines = (res.stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const windowTitle = sanitizeContextText(lines[0] || "", { maxChars: 512 });
  const processName = sanitizeContextText(lines[1] || "", { maxChars: 128 });

  if (!windowTitle && !processName) {
    return { available: false, reason: "no foreground window info" };
  }

  return {
    available: true,
    platform: "win32",
    method: "powershell",
    processName,
    windowTitle,
  };
}

function getActiveWindowContext() {
  try {
    if (process.platform === "darwin") return getMacOSContext();
    if (process.platform === "win32") return getWindowsContext();
    return getLinuxXdotoolContext();
  } catch (error) {
    return { available: false, reason: error?.message || String(error) };
  }
}

module.exports = {
  getActiveWindowContext,
};
