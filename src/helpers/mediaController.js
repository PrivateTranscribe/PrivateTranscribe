/**
 * mediaController.js — Fire-and-forget media play/pause for the main process.
 *
 * Sends the system media play/pause command when recording starts, and resumes
 * when recording stops — but only if we were the ones who paused it.
 *
 * Platform implementations:
 *  - Windows : uses SMTC WinRT API directly via PowerShell to TryPauseAsync /
 *              TryPlayAsync on the specific session that was playing.
 *              Stores the SourceAppUserModelId of the paused session so we
 *              resume the same app at the end — not whatever happens to be the
 *              "current" SMTC session later.
 *
 *              ⚠ WHY WE DO NOT USE THE GLOBAL MEDIA KEY ON WINDOWS:
 *              Windows routes VK_MEDIA_PLAY_PAUSE to the active SMTC session,
 *              which is not guaranteed to be the app that was playing when
 *              recording started.  If the user has both Spotify and a browser
 *              tab open, the key can hit the wrong target, accidentally starting
 *              a paused player or pausing something we never touched.  Direct
 *              per-session API calls are strictly more correct and targeted.
 *
 *  - macOS   : checks Spotify/Music.app state via AppleScript, then sends
 *              key code 100 (F8 / media play-pause).
 *  - Linux   : playerctl status check, then playerctl play-pause / xdotool fallback.
 *
 * Fail-safe: if state cannot be determined we do NOT send any command.  It is
 * much better to skip pausing than to accidentally start playback.
 *
 * All operations are fire-and-forget, <50 ms overhead, and fail silently.
 */

"use strict";

const { exec } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function runCmd(cmd) {
  try {
    exec(cmd, { timeout: 3000 }, () => {});
  } catch (_) {
    // Ignore spawn errors — fail silently
  }
}

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

/**
 * Returns true if Spotify or Music.app is currently playing on macOS.
 * Uses AppleScript to query each player's state directly — no key injection.
 * Resolves false on error or if no known player is playing (fail safe).
 */
function isMediaPlayingMac() {
  return new Promise((resolve) => {
    const script = [
      "set playing to false",
      "try",
      '  if application "Spotify" is running then',
      '    tell application "Spotify"',
      "      if player state is playing then set playing to true",
      "    end tell",
      "  end if",
      "end try",
      "try",
      '  if application "Music" is running then',
      '    tell application "Music"',
      "      if player state is playing then set playing to true",
      "    end tell",
      "  end if",
      "end try",
      "return playing",
    ].join("\n");

    exec(`osascript -e '${script}'`, { timeout: 3000 }, (err, stdout) => {
      resolve(!err && stdout.trim() === "true");
    });
  });
}

// ---------------------------------------------------------------------------
// Windows — direct SMTC session control (no global key toggle)
// ---------------------------------------------------------------------------

/**
 * Attempts to pause the currently-playing SMTC session directly via WinRT.
 *
 * Uses TryPauseAsync() on the session object rather than sending a global
 * VK_MEDIA_PLAY_PAUSE key.  The global key is unreliable because Windows
 * routes it to whatever session is currently "active", which may not be the
 * one that is actually playing.
 *
 * On success: resolves with the SourceAppUserModelId string of the paused
 *   session (e.g. "Spotify.exe" or a UWP AUMID) so we can target the same
 *   session for resume.
 * On failure / no playing media: resolves with null (fail safe, no action).
 *
 * PowerShell is used only for this read+control WinRT query.  The script
 * does not inject keystrokes, hook processes, or write to shared state.
 */
function pauseMediaWindowsDirect() {
  return new Promise((resolve) => {
    const ps1 = path.join(os.tmpdir(), "pt_smtc_pause.ps1");
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "try {",
      "    Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null",
      // Get the SMTC session manager via its WinRT async factory.
      "    $async = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]::RequestAsync()",
      // Reflect on AsTask<T> (single-parameter overload) for WinRT→TPL bridging.
      "    $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 })[0]",
      "    $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]",
      "    $mgr = $asTask.MakeGenericMethod($mgrType).Invoke($null, @($async)).GetAwaiter().GetResult()",
      // Prefer the session that is actively playing over the SMTC "current" session,
      // since the current session may be a paused or stopped one with focus.
      "    $playingSession = $null",
      "    foreach ($sess in $mgr.GetSessions()) {",
      "        if ($sess.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing') {",
      "            $playingSession = $sess",
      "            break",
      "        }",
      "    }",
      // Fall back to the SMTC current session if no explicitly-playing one found.
      "    if ($null -eq $playingSession) { $playingSession = $mgr.GetCurrentSession() }",
      "    if ($null -eq $playingSession) { exit 1 }",
      "    if ($playingSession.GetPlaybackInfo().PlaybackStatus.ToString() -ne 'Playing') { exit 1 }",
      // Call TryPauseAsync() directly on the session — targeted, not global.
      "    $pauseOp = $playingSession.TryPauseAsync()",
      "    $paused = $asTask.MakeGenericMethod([System.Boolean]).Invoke($null, @($pauseOp)).GetAwaiter().GetResult()",
      "    if ($paused) {",
      // Output the AUMID so Node.js can store it for the targeted resume call.
      "        Write-Output $playingSession.SourceAppUserModelId",
      "        exit 0",
      "    }",
      "    exit 1",
      "} catch { exit 2 }",
    ].join("\r\n");

    try {
      fs.writeFileSync(ps1, script, "utf8");
    } catch (_) {
      resolve(null);
      return;
    }

    exec(
      `powershell -NonInteractive -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`,
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err === null) {
          // stdout contains the AUMID of the paused session.
          resolve(stdout.trim() || "unknown");
        } else {
          resolve(null);
        }
      }
    );
  });
}

/**
 * Attempts to resume a specific SMTC session identified by its AUMID.
 *
 * Uses TryPlayAsync() on the matching session object — does not send any
 * global key.  If the session is no longer present (app closed), resolves
 * false silently.
 *
 * @param {string} aumid  SourceAppUserModelId returned by pauseMediaWindowsDirect.
 */
function resumeMediaWindowsDirect(aumid) {
  return new Promise((resolve) => {
    if (!aumid) {
      resolve(false);
      return;
    }

    // AUMIDs are Windows-generated app identifiers.  Strip quotes and
    // backticks to prevent any accidental PowerShell interpretation.
    const safeAumid = aumid.replace(/['"`;]/g, "");

    const ps1 = path.join(os.tmpdir(), "pt_smtc_resume.ps1");
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "try {",
      "    Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null",
      "    $async = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]::RequestAsync()",
      "    $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 })[0]",
      "    $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]",
      "    $mgr = $asTask.MakeGenericMethod($mgrType).Invoke($null, @($async)).GetAwaiter().GetResult()",
      // Find the exact session we paused by its AUMID.
      `    $target = '${safeAumid}'`,
      "    $s = $mgr.GetSessions() | Where-Object { $_.SourceAppUserModelId -eq $target } | Select-Object -First 1",
      "    if ($null -eq $s) { exit 1 }",
      // Call TryPlayAsync() directly — targeted resume, not global key toggle.
      "    $playOp = $s.TryPlayAsync()",
      "    $resumed = $asTask.MakeGenericMethod([System.Boolean]).Invoke($null, @($playOp)).GetAwaiter().GetResult()",
      "    if ($resumed) { exit 0 }",
      "    exit 1",
      "} catch { exit 2 }",
    ].join("\r\n");

    try {
      fs.writeFileSync(ps1, script, "utf8");
    } catch (_) {
      resolve(false);
      return;
    }

    exec(
      `powershell -NonInteractive -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`,
      { timeout: 5000, windowsHide: true },
      (err) => {
        resolve(err === null);
      }
    );
  });
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// True only if we sent the pause command and should resume later (macOS / Linux).
let didPause = false;

// AUMID of the SMTC session we paused on Windows.  Non-null only when we
// actually called TryPauseAsync successfully.
let pausedWindowsAumid = null;

// Tracks the in-flight pauseMedia() promise so resumeMedia() can await it.
// Race condition fix: pauseMedia() is async (2–5 s state check + WinRT call),
// but resumeMedia() may arrive before it finishes.  Without this, resumeMedia()
// would see didPause=false / pausedWindowsAumid=null, skip the resume, and then
// the pause would complete and leave media permanently paused.
let pendingPausePromise = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Internal async implementation — does the actual state check + pause.
 */
async function _doPauseMedia() {
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
    // Direct SMTC session control — no global VK_MEDIA_PLAY_PAUSE key.
    const aumid = await pauseMediaWindowsDirect();
    if (!aumid) {
      pausedWindowsAumid = null;
      return;
    }
    pausedWindowsAumid = aumid;
  } else if (platform === "darwin") {
    const playing = await isMediaPlayingMac();
    if (!playing) {
      didPause = false;
      return;
    }
    runCmd("osascript -e 'tell application \"System Events\" to key code 100'");
    didPause = true;
  }
}

/**
 * Pause the currently playing media, if any.
 * On Windows: calls TryPauseAsync on the specific SMTC session and stores its
 *   AUMID for a targeted resume.
 * On macOS/Linux: checks state first, then sends media key (fail safe).
 * Stores the in-flight promise so resumeMedia() can await it if called early.
 */
async function pauseMedia() {
  try {
    pendingPausePromise = _doPauseMedia();
    await pendingPausePromise;
  } catch (_) {
    // Fail silently
  } finally {
    pendingPausePromise = null;
  }
}

/**
 * Resume media playback — only if we were the ones who paused it.
 *
 * IMPORTANT: This is async because pauseMedia() may still be running its
 * WinRT/AppleScript state check when this is called (e.g. user stops
 * recording very quickly).  We await the pending pause before inspecting
 * state so we act on the final settled value, not a mid-check snapshot.
 */
async function resumeMedia() {
  try {
    if (pendingPausePromise) {
      await pendingPausePromise;
    }

    const platform = process.platform;

    if (platform === "win32") {
      if (!pausedWindowsAumid) return;
      const aumid = pausedWindowsAumid;
      pausedWindowsAumid = null;
      await resumeMediaWindowsDirect(aumid);
    } else {
      if (!didPause) return;
      didPause = false;

      if (platform === "linux") {
        runCmd("playerctl play-pause 2>/dev/null || xdotool key XF86AudioPlay");
      } else if (platform === "darwin") {
        runCmd("osascript -e 'tell application \"System Events\" to key code 100'");
      }
    }
  } catch (_) {
    // Fail silently
  }
}

module.exports = { pauseMedia, resumeMedia };
