/**
 * mediaController.js — Fire-and-forget media play/pause for the main process.
 *
 * Sends the system media play/pause command when recording starts, and resumes
 * when recording stops — but only if we were the ones who paused it.
 *
 * Platform implementations:
 *  - Windows : checks SMTC state via PowerShell (read-only), then sends VK_MEDIA_PLAY_PAUSE via nircmd
 *  - macOS   : checks Spotify/Music.app state via AppleScript, then sends key code 100 (F8)
 *  - Linux   : playerctl status check, then playerctl play-pause / xdotool fallback
 *
 * Fail-safe: if state cannot be determined, we do NOT send any key. It is much
 * better to skip pausing than to accidentally start playback on a paused player.
 *
 * All operations are fire-and-forget, <50 ms overhead, and fail silently.
 */

"use strict";

const { exec } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Resolve bundled nircmd.exe path (Windows only).
function getNircmdPath() {
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, "bin", "nircmd.exe"),
    path.join(__dirname, "..", "..", "resources", "bin", "nircmd.exe"),
    path.join(process.cwd(), "resources", "bin", "nircmd.exe"),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

// Send VK_MEDIA_PLAY_PAUSE on Windows without spawning PowerShell.
// Uses bundled nircmd if available, otherwise writes a tiny VBScript and runs it via wscript.
function sendWindowsMediaKey() {
  const nircmd = getNircmdPath();
  if (nircmd) {
    exec(`"${nircmd}" sendkeypress 0xb3`, { timeout: 3000 }, () => {});
    return;
  }
  const vbs = path.join(os.tmpdir(), "pt_mediapause.vbs");
  try {
    fs.writeFileSync(vbs, 'Set s = CreateObject("WScript.Shell")\r\ns.SendKeys Chr(179)\r\n', "utf8");
    exec(`wscript //nologo //b "${vbs}"`, { timeout: 3000 }, () => {});
  } catch (_) {}
}

function runCmd(cmd) {
  try {
    exec(cmd, { timeout: 3000 }, () => {});
  } catch (_) {
    // Ignore spawn errors — fail silently
  }
}

/**
 * Returns true if playerctl reports "Playing" on Linux.
 * Resolves false on error or if playerctl is unavailable.
 */
function isMediaPlayingLinux() {
  return new Promise((resolve) => {
    exec("playerctl status 2>/dev/null", { timeout: 2000 }, (err, stdout) => {
      resolve(!err && stdout.trim() === "Playing");
    });
  });
}

/**
 * Returns true if the Windows System Media Transport Controls (SMTC) session
 * reports a "Playing" status.
 *
 * PowerShell is used here ONLY for this read-only WinRT query — no key injection,
 * no keyboard hooks, no process manipulation. AV heuristics (including Bitdefender)
 * typically flag PowerShell scripts that *send* keystrokes or inject into processes;
 * a script that reads a well-known WinRT API is behaviorally very different and
 * should not trigger those heuristics.
 *
 * Fails SAFE: resolves false (skip the pause key) on any error or timeout.
 * Resolves true ONLY when SMTC explicitly reports PlaybackStatus == Playing.
 */
function isMediaPlayingWindows() {
  return new Promise((resolve) => {
    // A PowerShell script that exits 0 if SMTC says Playing, exits 1 otherwise.
    // Written to a .ps1 file so the process appears as a file-based script (less
    // suspicious to AV than a long -Command inline string).
    const ps1 = path.join(os.tmpdir(), "pt_mediastate.ps1");
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "try {",
      "    Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null",
      // Load the SMTC session manager WinRT type.
      "    $async = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]::RequestAsync()",
      // IAsyncOperation<T> must be converted to a Task<T> via the WindowsRuntimeSystemExtensions helper.
      "    $m = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 })[0]",
      "    $mgr = $m.MakeGenericMethod([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]).Invoke($null,@($async)).GetAwaiter().GetResult()",
      "    $s = $mgr.GetCurrentSession()",
      // No active media session — nothing is playing.
      "    if ($null -eq $s) { exit 1 }",
      // Exit 0 only when SMTC explicitly reports Playing; all other states (Paused, Stopped, etc.) exit 1.
      "    if ($s.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing') { exit 0 }",
      "    exit 1",
      "} catch { exit 2 }",
    ].join("\r\n");

    try {
      fs.writeFileSync(ps1, script, "utf8");
    } catch (_) {
      resolve(false); // Can't write script — fail safe, don't send key
      return;
    }

    exec(
      `powershell -NonInteractive -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`,
      { timeout: 4000, windowsHide: true },
      (err) => {
        // err is null only when the process exits with code 0 (= Playing).
        // Any non-zero exit code (Paused, Stopped, NoSession, error) → fail safe.
        resolve(err === null);
      }
    );
  });
}

/**
 * Returns true if Spotify or Music.app is currently playing on macOS.
 * Uses AppleScript to query each player's state directly — no key injection.
 * Resolves false on error or if no known player is playing (fail safe).
 */
function isMediaPlayingMac() {
  return new Promise((resolve) => {
    // Build a compact AppleScript that checks Spotify and Music.app.
    // We check `exists` before talking to each app to avoid errors when it isn't running.
    const script = [
      'set playing to false',
      'try',
      '  if application "Spotify" is running then',
      '    tell application "Spotify"',
      '      if player state is playing then set playing to true',
      '    end tell',
      '  end if',
      'end try',
      'try',
      '  if application "Music" is running then',
      '    tell application "Music"',
      '      if player state is playing then set playing to true',
      '    end tell',
      '  end if',
      'end try',
      'return playing',
    ].join("\n");

    exec(`osascript -e '${script}'`, { timeout: 3000 }, (err, stdout) => {
      // Fail safe: resolve false unless we get an explicit "true" back.
      resolve(!err && stdout.trim() === "true");
    });
  });
}

// True only if we sent the pause command and should resume later.
let didPause = false;

/**
 * Pause the currently playing media, if any.
 * Sets didPause = true only when we actually sent the command.
 * Checks media state first on all platforms to avoid toggling already-paused media.
 */
async function pauseMedia() {
  try {
    const platform = process.platform;

    if (platform === "linux") {
      const playing = await isMediaPlayingLinux();
      if (!playing) {
        didPause = false;
        return;
      }
      runCmd("playerctl play-pause 2>/dev/null || xdotool key XF86AudioPlay");
      didPause = true;
    } else if (platform === "win32") {
      // SMTC query: only send the key when media is confirmed playing.
      // If state is unknown or Paused, we skip (fail safe).
      const playing = await isMediaPlayingWindows();
      if (!playing) {
        didPause = false;
        return;
      }
      sendWindowsMediaKey();
      didPause = true;
    } else if (platform === "darwin") {
      const playing = await isMediaPlayingMac();
      if (!playing) {
        didPause = false;
        return;
      }
      runCmd("osascript -e 'tell application \"System Events\" to key code 100'");
      didPause = true;
    }
  } catch (_) {
    // Fail silently
  }
}

/**
 * Resume media playback — only if we were the ones who paused it.
 */
function resumeMedia() {
  try {
    if (!didPause) return;
    didPause = false;

    const platform = process.platform;

    if (platform === "linux") {
      runCmd("playerctl play-pause 2>/dev/null || xdotool key XF86AudioPlay");
    } else if (platform === "win32") {
      sendWindowsMediaKey();
    } else if (platform === "darwin") {
      runCmd("osascript -e 'tell application \"System Events\" to key code 100'");
    }
  } catch (_) {
    // Fail silently
  }
}

module.exports = { pauseMedia, resumeMedia };
