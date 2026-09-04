/**
 * mediaController.js — Fire-and-forget media play/pause for the main process.
 *
 * Sends the system media play/pause command when recording starts, and resumes
 * when recording stops — but only if we were the ones who paused it.
 *
 * Platform implementations:
 *  - Windows : Primary path — SMTC WinRT API via PowerShell TryPauseAsync /
 *              TryPlayAsync on the specific session that was playing.
 *              Stores the SourceAppUserModelId so we resume the same app.
 *
 *              Fallback path — when TryPauseAsync returns false (common for
 *              Spotify Win32 which registers with SMTC but doesn't honour
 *              TryPauseAsync), falls back to nircmd.exe mediaplay which sends
 *              VK_MEDIA_PLAY_PAUSE.  This is only triggered after the SMTC
 *              check has confirmed that something is actually Playing, so we
 *              never accidentally start a paused or stopped player.  nircmd
 *              routes the key to the current SMTC session, which at this point
 *              is the session we just verified as playing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TODO: Windows "Pause Media" feature is currently DISABLED IN UI (shows as
 * "Coming Soon") because it has not been reliable enough to ship.
 *
 * Full history of attempts (2026-03-26):
 *
 * 1. Original implementation: sent VK_MEDIA_PLAY_PAUSE global media key via
 *    nircmd.exe or PowerShell `$wshell.SendKeys([char]179)`. This is inherently
 *    unreliable on Windows because the key is routed to the active SMTC session,
 *    which is not always the app that is playing. Could accidentally start a
 *    paused Spotify while YouTube was focused, etc.
 *
 * 2. PowerShell VBScript approach: used wscript.exe to avoid PowerShell AV
 *    heuristics. Triggered a Windows Script Host popup bug — reverted.
 *
 * 3. SMTC direct session control: used WinRT GlobalSystemMediaTransportControls
 *    SessionManager via PowerShell reflection to call TryPauseAsync on the
 *    specific playing session. This is correct architecture but TryPauseAsync
 *    returns false for Spotify Win32 (non-Store) — Spotify registers with SMTC
 *    but does not honour the WinRT pause API. Added nircmd fallback when
 *    TryPauseAsync fails, only after confirming something IS playing.
 *
 * 4. Wiring bug discovered: the overlay button click path used a different
 *    code path that completely bypassed pauseMedia(). Fixed by consolidating
 *    into beginRecordingFlow()/endRecordingFlow() in useAudioRecording.js.
 *
 * 5. Despite all fixes, Windows media pause still unreliable in testing.
 *    Decision: disable in UI on Windows, show "Coming Soon" badge.
 *
 * What a proper Windows fix would look like:
 *  - Option A: Spotify Web API local control (requires Spotify app to be
 *    running and user to be authenticated) — complex but targeted
 *  - Option B: Detect media player by process and send app-specific commands
 *    (e.g. Spotify keyboard shortcut Ctrl+Space) — fragile, app-specific
 *  - Option C: Use a native Node addon (e.g. node-win-media-control) that
 *    wraps SMTC in a way that works for all SMTC-registered apps including
 *    Spotify Win32 — cleanest long-term solution, needs native build pipeline
 *  - Option D: Use Windows audio session API to detect what is playing, then
 *    send app-specific pause commands — possible with PowerShell but complex
 *
 * Until one of these is implemented and tested, the feature stays off on
 * Windows. Enforced by isMediaPauseSupported() below, not by the Settings UI —
 * a hidden toggle leaves its stored value behind and the feature keeps running.
 * ─────────────────────────────────────────────────────────────────────────────
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
const debugLogger = require("./debugLogger");

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
// Windows — nircmd helpers (used as fallback when SMTC TryPauseAsync fails)
// ---------------------------------------------------------------------------

/**
 * Returns the path to the bundled nircmd.exe, or null if not found.
 * Mirrors the search order used by clipboard.js.
 */
function findNircmdPath() {
  if (process.platform !== "win32") return null;
  const candidates = [];
  try {
    candidates.push(path.join(process.resourcesPath, "bin", "nircmd.exe"));
  } catch (_) {}
  candidates.push(
    path.join(__dirname, "..", "..", "resources", "bin", "nircmd.exe"),
    path.join(process.cwd(), "resources", "bin", "nircmd.exe")
  );
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

/**
 * Sends the system-wide VK_MEDIA_PLAY_PAUSE key via nircmd.
 * Windows routes this key to the current SMTC session regardless of the
 * foreground window, so it works from a background Electron process.
 * Used as a fallback when SMTC TryPauseAsync returns false (Spotify Win32).
 */
function nircmdMediaPlayPause(nircmdPath) {
  return new Promise((resolve) => {
    exec(`"${nircmdPath}" mediaplay`, { timeout: 2000, windowsHide: true }, (err) => {
      resolve(err === null);
    });
  });
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
    debugLogger.debug(
      "mediaController: pauseMediaWindowsDirect — writing SMTC pause script",
      undefined,
      "media"
    );
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
      // Emit all discovered SMTC sessions to stderr for diagnostics.
      // NOTE: If Spotify does not appear here it is not registered as an SMTC session
      // on this machine (possible with older Spotify builds or certain Windows configs).
      "    $sessions = $mgr.GetSessions()",
      "    [Console]::Error.WriteLine('SMTC-DEBUG: session_count=' + $sessions.Count)",
      "    foreach ($s in $sessions) {",
      "        [Console]::Error.WriteLine('SMTC-DEBUG: session aumid=' + $s.SourceAppUserModelId + ' status=' + $s.GetPlaybackInfo().PlaybackStatus.ToString())",
      "    }",
      // Prefer the session that is actively playing over the SMTC "current" session,
      // since the current session may be a paused or stopped one with focus.
      "    $playingSession = $null",
      "    foreach ($sess in $sessions) {",
      "        if ($sess.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing') {",
      "            $playingSession = $sess",
      "            break",
      "        }",
      "    }",
      // Fall back to the SMTC current session if no explicitly-playing one found.
      "    if ($null -eq $playingSession) { $playingSession = $mgr.GetCurrentSession() }",
      "    if ($null -eq $playingSession) { [Console]::Error.WriteLine('SMTC-DEBUG: no session found — exiting'); exit 1 }",
      "    if ($playingSession.GetPlaybackInfo().PlaybackStatus.ToString() -ne 'Playing') { [Console]::Error.WriteLine('SMTC-DEBUG: chosen session not Playing status=' + $playingSession.GetPlaybackInfo().PlaybackStatus.ToString()); exit 1 }",
      "    [Console]::Error.WriteLine('SMTC-DEBUG: chosen_aumid=' + $playingSession.SourceAppUserModelId)",
      // Call TryPauseAsync() directly on the session — targeted, not global.
      "    $pauseOp = $playingSession.TryPauseAsync()",
      "    $paused = $asTask.MakeGenericMethod([System.Boolean]).Invoke($null, @($pauseOp)).GetAwaiter().GetResult()",
      "    [Console]::Error.WriteLine('SMTC-DEBUG: TryPauseAsync result=' + $paused)",
      "    if ($paused) {",
      // Output the AUMID so Node.js can store it for the targeted resume call.
      "        Write-Output $playingSession.SourceAppUserModelId",
      "        exit 0",
      "    }",
      // TryPauseAsync returned false (Spotify Win32 and some other Win32 apps
      // register with SMTC but don't honour TryPauseAsync). Output the AUMID
      // so the caller can use nircmd as a fallback, then exit 3.
      "    [Console]::Error.WriteLine('SMTC-DEBUG: TryPauseAsync returned false — signalling nircmd fallback')",
      "    Write-Output $playingSession.SourceAppUserModelId",
      "    exit 3",
      "} catch { [Console]::Error.WriteLine('SMTC-DEBUG: exception ' + $_.Exception.Message); exit 2 }",
    ].join("\r\n");

    try {
      fs.writeFileSync(ps1, script, "utf8");
    } catch (_) {
      debugLogger.debug("mediaController: failed to write SMTC pause script", undefined, "media");
      resolve(null);
      return;
    }

    exec(
      `powershell -NonInteractive -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`,
      { timeout: 5000, windowsHide: true },
      async (err, stdout, stderr) => {
        // Log all PS diagnostic lines emitted to stderr.
        if (stderr) {
          for (const line of stderr.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed)
              debugLogger.debug(`mediaController: ps-pause: ${trimmed}`, undefined, "media");
          }
        }

        const exitCode = err === null ? 0 : err.code;

        if (exitCode === 0) {
          // SMTC TryPauseAsync succeeded — stdout contains the AUMID.
          const aumid = stdout.trim() || "unknown";
          debugLogger.debug(
            `mediaController: SMTC TryPauseAsync succeeded — aumid: ${aumid}`,
            undefined,
            "media"
          );
          resolve(aumid);
        } else if (exitCode === 3) {
          // SMTC found a playing session but TryPauseAsync returned false.
          // This is common for Spotify Win32.  Fall back to nircmd mediaplay
          // which sends VK_MEDIA_PLAY_PAUSE to the current SMTC session.
          const aumid = stdout.trim() || "unknown";
          debugLogger.debug(
            `mediaController: SMTC TryPauseAsync failed for aumid=${aumid}, trying nircmd fallback`,
            undefined,
            "media"
          );
          const nircmd = findNircmdPath();
          if (nircmd) {
            const ok = await nircmdMediaPlayPause(nircmd);
            if (ok) {
              debugLogger.debug(`mediaController: nircmd mediaplay succeeded`, undefined, "media");
              // Prefix the AUMID so resume knows to use nircmd again (toggle back).
              resolve("NIRCMD:" + aumid);
              return;
            }
            debugLogger.debug(`mediaController: nircmd mediaplay failed`, undefined, "media");
          } else {
            debugLogger.debug(
              `mediaController: nircmd not found, cannot pause media`,
              undefined,
              "media"
            );
          }
          resolve(null);
        } else {
          // Exit 1: no playing session found.  Exit 2: PS exception.
          debugLogger.debug(
            `mediaController: pause PS script — exit code ${exitCode} (no action)`,
            undefined,
            "media"
          );
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

    debugLogger.debug(
      `mediaController: resumeMediaWindowsDirect — targeting aumid: ${safeAumid}`,
      undefined,
      "media"
    );

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
      "    if ($null -eq $s) { [Console]::Error.WriteLine('SMTC-DEBUG: resume — target session not found aumid=' + $target); exit 1 }",
      "    [Console]::Error.WriteLine('SMTC-DEBUG: resume — found session aumid=' + $s.SourceAppUserModelId + ' status=' + $s.GetPlaybackInfo().PlaybackStatus.ToString())",
      // Call TryPlayAsync() directly — targeted resume, not global key toggle.
      "    $playOp = $s.TryPlayAsync()",
      "    $resumed = $asTask.MakeGenericMethod([System.Boolean]).Invoke($null, @($playOp)).GetAwaiter().GetResult()",
      "    [Console]::Error.WriteLine('SMTC-DEBUG: TryPlayAsync result=' + $resumed)",
      "    if ($resumed) { exit 0 }",
      "    exit 1",
      "} catch { [Console]::Error.WriteLine('SMTC-DEBUG: resume exception ' + $_.Exception.Message); exit 2 }",
    ].join("\r\n");

    try {
      fs.writeFileSync(ps1, script, "utf8");
    } catch (_) {
      debugLogger.debug("mediaController: failed to write SMTC resume script", undefined, "media");
      resolve(false);
      return;
    }

    exec(
      `powershell -NonInteractive -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`,
      { timeout: 5000, windowsHide: true },
      (err, _stdout, stderr) => {
        // Log all PS diagnostic lines emitted to stderr.
        if (stderr) {
          for (const line of stderr.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed)
              debugLogger.debug(`mediaController: ps-resume: ${trimmed}`, undefined, "media");
          }
        }
        const ok = err === null;
        debugLogger.debug(
          `mediaController: TryPlayAsync script result: ${ok ? "success" : `failed (code ${err?.code})`}`,
          undefined,
          "media"
        );
        resolve(ok);
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

// Platforms where "pause media while recording" is allowed to act.
//
// Windows is withdrawn (see the TODO at the top of this file). The Settings UI
// has shown "Soon" there ever since, but hiding a toggle does not clear what it
// stored: anyone who switched the feature on before it was withdrawn kept a
// `pauseMediaOnRecord=true` in localStorage, so the main process went on
// running the SMTC pause — and its nircmd fallback went on sending a global
// VK_MEDIA_PLAY_PAUSE — on every dictation, with no control left in the UI to
// stop it. Found on Kristian's own install: pauseMedia() invoked, twice, in
// logs written months after the feature was disabled.
//
// So the UI is not the gate. This is. Re-enabling Windows means deleting it
// from this set, and the stored preference each user already has comes back
// with it.
const MEDIA_PAUSE_UNSUPPORTED_PLATFORMS = new Set(["win32"]);

/**
 * Whether this platform may pause and resume media at all.
 * @param {string} [platform] Defaults to the running platform.
 */
function isMediaPauseSupported(platform = process.platform) {
  return !MEDIA_PAUSE_UNSUPPORTED_PLATFORMS.has(platform);
}

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
    debugLogger.debug(
      "mediaController: pauseMedia — Windows path, calling SMTC direct pause",
      undefined,
      "media"
    );
    // Direct SMTC session control — no global VK_MEDIA_PLAY_PAUSE key.
    const aumid = await pauseMediaWindowsDirect();
    if (!aumid) {
      debugLogger.debug(
        "mediaController: pauseMedia — no playing SMTC session found (or TryPauseAsync failed); skipping",
        undefined,
        "media"
      );
      pausedWindowsAumid = null;
      return;
    }
    pausedWindowsAumid = aumid;
    debugLogger.debug(
      `mediaController: pauseMedia — stored pausedWindowsAumid: ${aumid}`,
      undefined,
      "media"
    );
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
  debugLogger.debug(
    "mediaController: pauseMedia() invoked",
    { platform: process.platform },
    "media"
  );
  if (!isMediaPauseSupported()) {
    debugLogger.debug(
      "mediaController: pauseMedia — unsupported on this platform; no media command sent",
      { platform: process.platform },
      "media"
    );
    return;
  }
  try {
    pendingPausePromise = _doPauseMedia();
    await pendingPausePromise;
    debugLogger.debug("mediaController: pauseMedia() settled", undefined, "media");
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
  debugLogger.debug(
    "mediaController: resumeMedia() invoked",
    { platform: process.platform },
    "media"
  );
  if (!isMediaPauseSupported()) {
    debugLogger.debug(
      "mediaController: resumeMedia — unsupported on this platform; no media command sent",
      { platform: process.platform },
      "media"
    );
    return;
  }
  try {
    if (pendingPausePromise) {
      debugLogger.debug(
        "mediaController: resumeMedia() waiting on in-flight pauseMedia promise",
        undefined,
        "media"
      );
      await pendingPausePromise;
      debugLogger.debug(
        "mediaController: resumeMedia() in-flight pause settled, continuing",
        undefined,
        "media"
      );
    }

    const platform = process.platform;

    if (platform === "win32") {
      debugLogger.debug(
        `mediaController: resumeMedia — pausedWindowsAumid: ${pausedWindowsAumid ?? "null (nothing to resume)"}`,
        undefined,
        "media"
      );
      if (!pausedWindowsAumid) return;
      const aumid = pausedWindowsAumid;
      pausedWindowsAumid = null;
      if (aumid.startsWith("NIRCMD:")) {
        // We paused via nircmd media key (toggle) — send it again to resume.
        const nircmd = findNircmdPath();
        if (nircmd) await nircmdMediaPlayPause(nircmd);
      } else {
        await resumeMediaWindowsDirect(aumid);
      }
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

module.exports = { pauseMedia, resumeMedia, isMediaPauseSupported };
