/**
 * mediaController.js — Fire-and-forget media play/pause for the main process.
 *
 * Sends the system media play/pause command when recording starts, and resumes
 * when recording stops — but only if we were the ones who paused it.
 *
 * Platform implementations:
 *  - Windows : nircmd sendkeypress / wscript VBScript — VK_MEDIA_PLAY_PAUSE (char 179), no PowerShell
 *  - macOS   : AppleScript key code 100 (F8 / media play-pause)
 *  - Linux   : playerctl play-pause, falling back to xdotool XF86AudioPlay
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

// True only if we sent the pause command and should resume later.
let didPause = false;

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
 * Pause the currently playing media, if any.
 * Sets didPause = true only when we actually sent the command.
 * On Linux, checks playerctl status first to avoid toggling already-paused media.
 *
 * Note: Windows/macOS media state detection is non-trivial without fragile platform-
 * specific scripting. For now we keep the AV-safe key sending fix and resume tracking.
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
      sendWindowsMediaKey();
      didPause = true;
    } else if (platform === "darwin") {
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
