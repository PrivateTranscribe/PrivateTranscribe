"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const { sanitizeContextText } = require("./contextSanitizer");

// Small perf guard: active-window context capture can be called frequently.
// Cache command availability checks for the lifetime of the process.
const commandExistsCache = new Map();

function isSensitiveAppContext({ appName = "", processName = "", appClass = "", windowTitle = "" } = {}) {
  const appHay = [appName, processName, appClass].join(" ").toLowerCase();

  // Narrow denylist: password managers / auth apps + OS credential prompts.
  // Keep this conservative to avoid blocking common apps (e.g., browsers).
  const appPatterns = [
    // Password managers
    /\b1password\b/i,
    /\bbitwarden\b/i,
    /\blastpass\b/i,
    /\bdashlane\b/i,
    /\bnordpass\b/i,
    /\bkeepass(xc|2)?\b/i,
    /\bkeeper\b/i,
    /\broboform\b/i,
    /\benpass\b/i,
    /\bpassbolt\b/i,
    /\bproton\s*pass\b/i,
    /\bkeychain\s*access\b/i,
    /\bgnome\s*keyring\b/i,
    /\bseahorse\b/i,
    /\bkwallet/i,
    /\bkde\s*wallet/i,
    /\bpasswords\b/i, // macOS "Passwords" app

    // Auth tools / 2FA
    /\bauthy\b/i,
    /\bokta\b/i,
    /\bduo(\s*mobile)?\b/i,
    /\bgoogle\s*authenticator\b/i,
    /\bmicrosoft\s*authenticator\b/i,
    /\b2fas\b/i,

    // Windows credential / secure desktop surfaces (best-effort; names vary)
    /\bcredentialuibroker\b/i,
    /\blogonui\b/i,
    /\blockapp\b/i,
    /\bconsent(\.exe)?\b/i,
  ];

  if (appPatterns.some((p) => p.test(appHay))) return true;

  // Window title guardrails:
  // - Only match well-known sensitive app names (avoid generic terms like "passwords" in document titles).
  // - Also block explicit OS credential prompt wording.
  const title = (windowTitle || "").toLowerCase();
  const titlePatterns = appPatterns.filter((p) => p.toString() !== /\bpasswords\b/i.toString());
  if (titlePatterns.some((p) => p.test(title))) return true;

  // Avoid overly broad terms like "login" that would cause false positives.
  if (title.includes("enter password") || title.includes("master password")) return true;
  if (title.includes("windows security") || title.includes("user account control")) return true;

  return false;
}

function run(cmd, args, { timeoutMs = 2500, maxBuffer = 1024 * 1024 } = {}) {
  try {
    const res = spawnSync(cmd, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer,
    });

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

function isExecutableFile(p) {
  try {
    const stat = fs.statSync(p);
    if (!stat.isFile()) return false;

    // On Windows, existence is usually sufficient (PATHEXT controls runnable types).
    if (process.platform === "win32") return true;

    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveOnPath(cmd) {
  const envPath = String(process.env.PATH || "");
  const dirs = envPath.split(path.delimiter).filter(Boolean);

  // Windows: respect PATHEXT for runnable suffixes.
  const pathext = process.platform === "win32" ? String(process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM") : "";
  const exts =
    process.platform === "win32"
      ? pathext
          .split(";")
          .map((e) => e.trim())
          .filter(Boolean)
          .map((e) => (e.startsWith(".") ? e : `.${e}`))
      : [""];

  const cmdExt = process.platform === "win32" ? path.extname(cmd) : "";
  const hasKnownExt = process.platform === "win32" && cmdExt && exts.some((e) => e.toLowerCase() === cmdExt.toLowerCase());

  for (const dir of dirs) {
    // Avoid interpreting relative dirs; PATH entries can be relative but that's uncommon.
    const base = path.join(dir, cmd);

    // If cmd already includes a PATHEXT extension (e.g. "powershell.exe"), try it directly first.
    if (process.platform === "win32" && hasKnownExt) {
      if (isExecutableFile(base)) return base;
      continue;
    }

    for (const ext of exts) {
      const candidate = process.platform === "win32" ? `${base}${ext}` : base;
      if (isExecutableFile(candidate)) return candidate;
    }
  }

  return null;
}

function commandExists(cmd) {
  // No shell, no paths, no metacharacters.
  // Windows: allow an extension (e.g. "foo.exe") while still forbidding paths.
  const pattern = process.platform === "win32" ? /^[a-zA-Z0-9_.-]+$/ : /^[a-zA-Z0-9_-]+$/;
  if (!pattern.test(cmd)) return false;
  if (cmd.includes("/") || cmd.includes("\\")) return false;

  if (commandExistsCache.has(cmd)) return commandExistsCache.get(cmd);

  const ok = !!resolveOnPath(cmd);
  commandExistsCache.set(cmd, ok);
  return ok;
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

  if (isSensitiveAppContext({ appClass, windowTitle })) {
    return { available: false, reason: "sensitive app/window", blocked: true };
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

  if (isSensitiveAppContext({ appName, windowTitle })) {
    return { available: false, reason: "sensitive app/window", blocked: true };
  }

  return {
    available: true,
    platform: "darwin",
    method: "osascript",
    appName,
    windowTitle,
  };
}

function shouldCaptureContextCapture() {
  // Allow privacy- or policy-conscious users to fully disable *all* active-window context capture.
  // Default: enabled (best-effort + privacy-first sanitization + hard limits).
  const raw = String(process.env.PRIVOCA_DISABLE_CONTEXT_CAPTURE || "").trim().toLowerCase();
  return !(raw === "1" || raw === "true" || raw === "yes");
}

function shouldCaptureWindowsUia() {
  // Allow privacy- or policy-conscious users to fully disable UIA capture.
  // Default: enabled (best-effort + privacy-first sanitization + hard limit).
  const raw = String(process.env.PRIVOCA_DISABLE_WINDOWS_UIA || "").trim().toLowerCase();
  return !(raw === "1" || raw === "true" || raw === "yes");
}

function getWindowsUiaText() {
  if (!shouldCaptureWindowsUia()) return {};

  // Best-effort UI Automation (UIA) focused element text.
  // Privacy-first: sanitized + hard-limited; failures simply omit the field.
  const ps = `# Load UI Automation types (best-effort). LoadWithPartialName is deprecated.
try { Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue } catch {}
try { $el = [System.Windows.Automation.AutomationElement]::FocusedElement } catch { $el = $null }
if ($null -eq $el) { exit 0 }

# If the focused element is a password field, do not capture any text.
# (UIA can expose ValuePattern/Name; even best-effort capture would be unsafe.)
try {
  $isPwd = $el.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::IsPasswordProperty)
  if ($isPwd -eq $true) { exit 0 }
} catch {}

$txt = \"\"

# Prefer ValuePattern for typical text inputs.
try {
  $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  if ($vp -ne $null) { $txt = $vp.Current.Value }
} catch {}

# Fallback: element Name for many controls.
if (-not $txt) {
  try { $txt = $el.Current.Name } catch { $txt = \"\" }
}

# Fallback: TextPattern for richer controls (e.g. document views).
# Limit to a small number of chars to stay privacy-first.
if (-not $txt) {
  try {
    $tp = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    if ($tp -ne $null) {
      $range = $tp.DocumentRange
      if ($range -ne $null) { $txt = $range.GetText(512) }
    }
  } catch {}
}

$txt;`;

  const res = run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-Command",
      ps,
    ],
    { timeoutMs: 4000 }
  );

  if (!res.ok) return {};

  const raw = (res.stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .trim();

  const uiaText = sanitizeContextText(raw, { maxChars: 512 });
  if (!uiaText) return {};

  return {
    uiaText,
    uiaMethod: "uia-focusedelement",
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

  const res = run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-Command",
      ps,
    ],
    { timeoutMs: 4000 }
  );

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

  if (isSensitiveAppContext({ processName, windowTitle })) {
    return { available: false, reason: "sensitive app/window", blocked: true };
  }

  const uia = getWindowsUiaText();

  return {
    available: true,
    platform: "win32",
    method: "powershell",
    processName,
    windowTitle,
    ...uia,
  };
}

function getActiveWindowContext() {
  try {
    if (!shouldCaptureContextCapture()) {
      return { available: false, reason: "context capture disabled by env", disabled: true };
    }

    if (process.platform === "darwin") return getMacOSContext();
    if (process.platform === "win32") return getWindowsContext();
    return getLinuxXdotoolContext();
  } catch (error) {
    return { available: false, reason: error?.message || String(error) };
  }
}

module.exports = {
  getActiveWindowContext,
  isSensitiveAppContext,
  shouldCaptureContextCapture,
  shouldCaptureWindowsUia,
};
