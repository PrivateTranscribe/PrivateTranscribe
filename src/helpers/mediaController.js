/**
 * mediaController.js — Fire-and-forget media play/pause for the main process.
 *
 * Sends the system media play/pause command when recording starts, and resumes
 * when recording stops — but only if we were the ones who paused it.
 *
 * Platform implementations:
 *  - Windows : PowerShell VK_MEDIA_PLAY_PAUSE (char 179)
 *  - macOS   : AppleScript key code 100 (F8 / media play-pause)
 *  - Linux   : playerctl play-pause, falling back to xdotool XF86AudioPlay
 *
 * All operations are fire-and-forget, <50 ms overhead, and fail silently.
 */

"use strict";

const { exec } = require("child_process");

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
      runCmd(
        'powershell -WindowStyle Hidden -Command "$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys([char]179)"'
      );
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
      runCmd(
        'powershell -WindowStyle Hidden -Command "$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys([char]179)"'
      );
    } else if (platform === "darwin") {
      runCmd("osascript -e 'tell application \"System Events\" to key code 100'");
    }
  } catch (_) {
    // Fail silently
  }
}

module.exports = { pauseMedia, resumeMedia };
