const { execFile } = require("child_process");
const debugLogger = require("./debugLogger");

// ─── Windows: PowerShell + C# COM interop (IAudioEndpointVolume) ─────────────
//
// The C# type is the canonical approach confirmed working on Windows 10/11.
// Key correctness requirements:
//   • Stub methods (f,g,h,i,j,k,l,m,n) must match the COM vtable layout exactly
//   • Parameters must be Guid by VALUE (not ref) for pguidEventContext
//   • [MarshalAs(UnmanagedType.Bool)] is required for bool parameters
//   • uint (not int) for clsCtx in IMMDevice.Activate
//   • The closing "@ of the here-string must be on a line by itself at column 0
//
// This is embedded as a JS template literal but written to a temp .ps1 file
// so newlines are preserved exactly and no shell quoting issues occur.

const WIN_CS = `
using System;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float fLevel, System.Guid pguidEventContext);
  int j();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int k(); int l(); int m(); int n();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, System.Guid pguidEventContext);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref System.Guid id, uint clsCtx, IntPtr pActivationParams,
    [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int NotImpl1();
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject {}

public static class Audio {
  static IAudioEndpointVolume Endpoint() {
    var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
    IMMDevice dev;
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out dev));
    object epv;
    var epvGuid = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(dev.Activate(ref epvGuid, 23, IntPtr.Zero, out epv));
    return epv as IAudioEndpointVolume;
  }
  public static float GetVolume() {
    float v;
    Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out v));
    return v;
  }
  public static void SetVolume(float level) {
    Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(level, System.Guid.Empty));
  }
  public static bool GetMute() {
    bool m;
    Marshal.ThrowExceptionForHR(Endpoint().GetMute(out m));
    return m;
  }
  public static void SetMute(bool mute) {
    Marshal.ThrowExceptionForHR(Endpoint().SetMute(mute, System.Guid.Empty));
  }
}
`.trim();

// ─── PowerShell runner ────────────────────────────────────────────────────────
//
// We write a .ps1 script file rather than passing the script as a -Command
// argument. This avoids ALL PowerShell command-line quoting / newline issues.
// The temp file is written to the system temp directory.

const os = require("os");
const fs = require("fs");
const path = require("path");

const SCRIPT_DIR = os.tmpdir();

/** Write a ps1 script temp-file and execute it. Returns stdout as a string. */
function runPs(scriptBody) {
  return new Promise((resolve, reject) => {
    // Give each script a predictable path (overwritten each call)
    const scriptPath = path.join(SCRIPT_DIR, "privoca_audio_duck.ps1");

    // Build the full script: define the type, then run the body
    const fullScript = [
      'Add-Type -TypeDefinition @"',
      WIN_CS,
      '"@',
      "", // blank line after here-string closing delimiter (safety)
      scriptBody,
    ].join("\n");

    fs.writeFile(scriptPath, fullScript, "utf8", (writeErr) => {
      if (writeErr) return reject(writeErr);

      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        { windowsHide: true, timeout: 8000 },
        (err, stdout, stderr) => {
          if (err) {
            if (stderr) debugLogger.error("[AudioDucking] PS stderr:", stderr.trim());
            return reject(err);
          }
          if (stderr && stderr.trim()) {
            // Add-Type warnings are common for already-defined types; downgrade to debug
            debugLogger.debug("[AudioDucking] PS stderr:", stderr.trim());
          }
          resolve(stdout.trim());
        }
      );
    });
  });
}

// ─── macOS ───────────────────────────────────────────────────────────────────

function execCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 4000 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
}

const macos = {
  async getState() {
    const volRaw = await execCmd("osascript", ["-e", "output volume of (get volume settings)"]);
    const muteRaw = await execCmd("osascript", ["-e", "output muted of (get volume settings)"]);
    return {
      volume: Math.round(parseInt(volRaw, 10)) / 100,
      muted: muteRaw.trim() === "true",
    };
  },
  async setVolume(level) {
    const vol = Math.round(Math.max(0, Math.min(1, level)) * 100);
    await execCmd("osascript", ["-e", `set volume output volume ${vol}`]);
  },
  async setMuted(muted) {
    await execCmd("osascript", [
      "-e",
      muted ? "set volume with output muted" : "set volume without output muted",
    ]);
  },
};

// ─── Linux ───────────────────────────────────────────────────────────────────

const linux = {
  async getState() {
    const volRaw = await execCmd("pactl", ["get-sink-volume", "@DEFAULT_SINK@"]);
    const muteRaw = await execCmd("pactl", ["get-sink-mute", "@DEFAULT_SINK@"]);
    const pctMatch = volRaw.match(/(\d+)%/);
    return {
      volume: pctMatch ? parseInt(pctMatch[1], 10) / 100 : 1,
      muted: muteRaw.toLowerCase().includes("yes"),
    };
  },
  async setVolume(level) {
    const pct = Math.round(Math.max(0, Math.min(1, level)) * 100);
    await execCmd("pactl", ["set-sink-volume", "@DEFAULT_SINK@", `${pct}%`]);
  },
  async setMuted(muted) {
    await execCmd("pactl", ["set-sink-mute", "@DEFAULT_SINK@", muted ? "1" : "0"]);
  },
};

// ─── Windows ─────────────────────────────────────────────────────────────────
//
// For duck(): a single PS invocation reads the current state (to stdout) AND
// applies the duck level. This halves the number of PS process launches.

/** PowerShell single-quoted literal: only ' needs escaping. */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Is `previous` a duck that never got its restore?
 *
 * Returns the PowerShell test for "the volume still looks like that duck", or
 * null when there is nothing to compare against.
 */
function buildStillDuckedTest(previous, f4) {
  if (!previous) return null;
  if (previous.mode === "mute") return "$mute";
  const target = Number(previous.duckTarget);
  if (!Number.isFinite(target) || !Number.isFinite(Number(previous.volume))) return null;
  return `$vol -le ${f4(target + STILL_DUCKED_EPSILON)}`;
}

/**
 * The body of the Windows duck script, as an array of lines.
 *
 * Extracted so a unit test can assert the two things that keep the master
 * volume recoverable:
 *
 *   1. The line that writes the state file comes BEFORE the line that moves the
 *      volume. Doing the write inside the same PowerShell process is what
 *      removes the crash window entirely — the alternative (read in one call,
 *      write, set in a second call) would pay a second Add-Type compile on
 *      every recording.
 *   2. When `previous` describes a duck whose restore never landed, the script
 *      ducks from THAT baseline instead of from the volume it can read now.
 *      Reading now would multiply an already-ducked volume by the duck level a
 *      second time, and the level the user actually chose would be gone.
 */
function buildWindowsDuckScriptLines({ mode, duckLevel, statePath, previous = null }) {
  const inv = "[System.Globalization.CultureInfo]::InvariantCulture";
  const f4 = (n) => `[float]::Parse('${Number(n).toFixed(4)}', ${inv})`;

  const lines = [
    "$vol = [Audio]::GetVolume()",
    "$mute = [Audio]::GetMute()",
    "$base = $vol",
    "$baseMute = $mute",
  ];

  const stillDucked = buildStillDuckedTest(previous, f4);
  if (stillDucked) {
    lines.push(
      `if (${stillDucked}) {`,
      `  $base = ${f4(previous.volume)}`,
      `  $baseMute = $${previous.muted ? "true" : "false"}`,
      "}"
    );
  }

  // stdout is the baseline to restore to later — which is the un-restored one
  // when we adopted it, not whatever the volume happens to be right now.
  lines.push(`Write-Output ($base.ToString('F4', ${inv}) + '|' + $baseMute.ToString())`);

  lines.push(
    mode === "mute" ? "$target = $base" : `$target = [Math]::Max(0.01, $base * ${f4(duckLevel)})`
  );

  if (statePath) {
    lines.push(
      `$state = '{"version":1,"mode":"${mode === "mute" ? "mute" : "duck"}","volume":' + ` +
        `$base.ToString('F4', ${inv}) + ` +
        `',"muted":' + $baseMute.ToString().ToLower() + ',"duckTarget":' + ` +
        `$target.ToString('F4', ${inv}) + ` +
        `',"timestamp":"' + [DateTime]::UtcNow.ToString('o', ${inv}) + '"}'`
    );
    lines.push(
      `[System.IO.File]::WriteAllText(${psQuote(statePath)}, $state, (New-Object System.Text.UTF8Encoding($false)))`
    );
  }

  lines.push(mode === "mute" ? "[Audio]::SetMute($true)" : "[Audio]::SetVolume($target)");
  return lines;
}

const windows = {
  /**
   * Duck in one PowerShell call:
   *   - Outputs "volume|muted" to stdout (the state to restore to later)
   *   - Writes the crash-safe state file
   *   - Then applies the new level/mute
   * @returns {Promise<{ volume: number, muted: boolean }>} the state to restore
   */
  async duckAndSave({ mode, duckLevel, statePath = null, previous = null }) {
    // duckLevel is a multiplier (e.g. 0.5 = half of the baseline volume).
    const stdout = await runPs(
      buildWindowsDuckScriptLines({ mode, duckLevel, statePath, previous }).join("\n")
    );
    // stdout = "0.8000|False" (pipe separator, invariant decimal)
    const firstLine = stdout.split(/\r?\n/)[0].trim();
    const pipeIdx = firstLine.indexOf("|");
    const volStr = pipeIdx >= 0 ? firstLine.slice(0, pipeIdx) : "1";
    const muteStr = pipeIdx >= 0 ? firstLine.slice(pipeIdx + 1) : "False";
    return {
      volume: parseFloat(volStr) || 1,
      muted: muteStr.toLowerCase() === "true",
    };
  },

  /** Read-only, for the startup repair's "does this still look ducked?" test. */
  async getState() {
    const stdout = await runPs(
      [
        "$vol = [Audio]::GetVolume()",
        "$mute = [Audio]::GetMute()",
        "Write-Output ($vol.ToString('F4', [System.Globalization.CultureInfo]::InvariantCulture) + '|' + $mute.ToString())",
      ].join("\n")
    );
    const firstLine = stdout.split(/\r?\n/)[0].trim();
    const pipeIdx = firstLine.indexOf("|");
    return {
      volume: pipeIdx >= 0 ? parseFloat(firstLine.slice(0, pipeIdx)) || 0 : 1,
      muted:
        pipeIdx >= 0 &&
        firstLine
          .slice(pipeIdx + 1)
          .trim()
          .toLowerCase() === "true",
    };
  },

  /**
   * Restore in one PowerShell call.
   *
   * The volume is always written back, mute or no mute: the duck script lowers
   * it either way, so a restore that only unmuted used to leave the slider down
   * for anyone who was already muted when the recording started.
   */
  async restore(savedState) {
    // Force invariant culture so locale decimal separators are not an issue
    const volStr = Number(savedState.volume).toFixed(4); // always dot-separated in JS
    await runPs(
      [
        `[Audio]::SetVolume([float]::Parse('${volStr}', [System.Globalization.CultureInfo]::InvariantCulture))`,
        savedState.muted ? "[Audio]::SetMute($true)" : "[Audio]::SetMute($false)",
      ].join("\n")
    );
  },
};

// ─── AudioDuckingManager ─────────────────────────────────────────────────────

/**
 * Name of the crash-safe state file, inside Electron's userData dir.
 *
 * Kristian's report: transcription ducking sometimes never restores — an error
 * path, or the app closed mid-duck — and his master volume stays lowered until
 * he fixes it by hand. The fix is this file: written before the volume moves,
 * deleted on a successful restore, and repaired from on the next start.
 */
const STATE_FILE_NAME = "audio-ducking-state.json";

/**
 * How far above the ducked target the master volume can sit and still count as
 * "still ducked". Wide enough for float rounding through PowerShell, narrow
 * enough that a user who has already dragged the slider back up is not yanked.
 */
const STILL_DUCKED_EPSILON = 0.02;

/**
 * Last-resort backstop: how long a duck may stand before it is undone without
 * anyone asking. A duck lasts exactly as long as one recording, so nothing
 * legitimate gets near this. If a renderer dies, an IPC message is dropped, or
 * some flow forgets its restore, the volume comes back on its own instead of
 * staying down until the app is restarted.
 */
const DUCK_WATCHDOG_MS = 10 * 60 * 1000;

/**
 * Should a leftover state file be acted on?
 *
 * Only when the system still LOOKS ducked. If the user already fixed the
 * volume by hand, the honest thing is to leave it where they put it and just
 * drop the file — restoring would move their slider out from under them.
 */
function shouldRepairFromState(state, current) {
  if (!state || !current) return false;
  if (state.mode === "mute") return Boolean(current.muted);
  const target = Number(state.duckTarget);
  if (!Number.isFinite(target)) return false;
  return Number(current.volume) <= target + STILL_DUCKED_EPSILON;
}

/**
 * What should this duck treat as "before"?
 *
 * `previous` is a state file that is still on disk, i.e. a duck whose restore
 * never landed. When the system still looks like that duck, its baseline is the
 * truth and the volume we can read now is the lowered one. Ducking from the
 * lowered one is what makes a spammed dictation button walk the volume down
 * 1.0 → 0.5 → 0.25 with no way back to where it started.
 */
function pickDuckBaseline(previous, current) {
  if (
    previous &&
    Number.isFinite(Number(previous.volume)) &&
    shouldRepairFromState(previous, current)
  ) {
    return { volume: Number(previous.volume), muted: Boolean(previous.muted), adopted: true };
  }
  return { volume: current.volume, muted: current.muted, adopted: false };
}

class AudioDuckingManager {
  /**
   * Dependencies are injectable for the same reason they are in
   * readAloudPlaybackKeys: vitest cannot mock `require("electron")` inside
   * src/helpers, so a unit test hands in a temp path and fake platform APIs
   * rather than replacing the module.
   */
  constructor({
    platform = process.platform,
    fs: fsModule = fs,
    logger = debugLogger,
    stateFilePath = null,
    platformApis = { win32: windows, darwin: macos, linux },
    watchdogMs = DUCK_WATCHDOG_MS,
  } = {}) {
    /** @type {{ volume: number, muted: boolean } | null} */
    this._savedState = null;
    this._isDucked = false;
    /**
     * Every duck, restore and repair runs one at a time on this chain.
     *
     * This is what makes the dictation button safe to spam. The old code
     * guarded on `_isDucked`, which only turns true once PowerShell has come
     * back — a few hundred milliseconds after the press — so a second press
     * started a second duck that read the already-ducked volume as if it were
     * the user's own, and a restore that arrived mid-duck could be cancelled by
     * the next press. Serialising closes both windows: by the time an operation
     * runs, the one before it has finished and the flags mean what they say.
     */
    this._chain = Promise.resolve();
    this._watchdogMs = watchdogMs;
    this._watchdogTimer = null;
    this._platform = platform;
    this._fs = fsModule;
    this._logger = logger;
    this._stateFilePath = stateFilePath;
    this._apis = platformApis;
  }

  /** Late-bind the userData dir, which only main.js knows. */
  configure({ userDataPath, stateFilePath } = {}) {
    if (stateFilePath) this._stateFilePath = stateFilePath;
    else if (userDataPath) this._stateFilePath = path.join(userDataPath, STATE_FILE_NAME);
    return this._stateFilePath;
  }

  /** @private Run `op` only once everything queued before it has finished. */
  _enqueue(op) {
    const run = this._chain.then(op);
    // The chain must never carry a rejection forward, or one failed duck would
    // skip every restore queued behind it.
    this._chain = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  /** @private */
  _armWatchdog() {
    this._clearWatchdog();
    if (!this._watchdogMs || this._watchdogMs <= 0) return;
    this._watchdogTimer = setTimeout(() => {
      this._watchdogTimer = null;
      this._logger.warn(
        `[AudioDucking] Nothing asked for the volume back within ${Math.round(
          this._watchdogMs / 1000
        )}s - putting it back anyway`
      );
      void this.restore();
    }, this._watchdogMs);
    // Never keep the app alive just to hold a backstop timer.
    this._watchdogTimer?.unref?.();
  }

  /** @private */
  _clearWatchdog() {
    if (!this._watchdogTimer) return;
    clearTimeout(this._watchdogTimer);
    this._watchdogTimer = null;
  }

  /** @private */
  _writeState(state) {
    if (!this._stateFilePath) return;
    try {
      // Synchronous on purpose: this has to be on disk before the volume moves,
      // which is the entire reason the file exists.
      this._fs.writeFileSync(this._stateFilePath, JSON.stringify(state), "utf8");
    } catch (error) {
      this._logger.warn("[AudioDucking] Could not write state file:", error?.message);
    }
  }

  /** @private */
  _clearState() {
    if (!this._stateFilePath) return;
    try {
      if (this._fs.existsSync(this._stateFilePath)) this._fs.unlinkSync(this._stateFilePath);
    } catch (error) {
      this._logger.warn("[AudioDucking] Could not delete state file:", error?.message);
    }
  }

  /** @private */
  _readState() {
    if (!this._stateFilePath) return null;
    try {
      if (!this._fs.existsSync(this._stateFilePath)) return null;
      return JSON.parse(this._fs.readFileSync(this._stateFilePath, "utf8"));
    } catch (error) {
      this._logger.warn("[AudioDucking] Unreadable state file:", error?.message);
      return null;
    }
  }

  /**
   * Put the master volume back if a previous run died mid-duck. Called once at
   * startup, before anything else can duck.
   */
  async repairFromDisk() {
    return this._enqueue(() => this._repairFromDisk());
  }

  /** @private The un-queued body, so an operation already on the queue can use it. */
  async _repairFromDisk() {
    const state = this._readState();
    if (!state) return { repaired: false, reason: "no-state-file" };

    const api = this._apis[this._platform];
    if (!api) {
      this._clearState();
      return { repaired: false, reason: "unsupported-platform" };
    }

    try {
      const current = await api.getState();
      if (!shouldRepairFromState(state, current)) {
        // The user already sorted it out. Their slider, their call.
        this._clearState();
        this._logger.info(
          "[AudioDucking] Found a stale duck state but the volume is already back up " +
            `(now ${current.volume}, ducked target ${state.duckTarget}) - leaving it alone`
        );
        return { repaired: false, reason: "already-restored", current };
      }

      await this._applyState({ volume: state.volume, muted: Boolean(state.muted) });
      this._clearState();
      this._logger.info(
        `[AudioDucking] Repaired a stranded duck from a previous run: ${current.volume} -> ${state.volume}`
      );
      return { repaired: true, from: current, to: state };
    } catch (error) {
      this._logger.error("[AudioDucking] Startup repair failed:", error?.message);
      // Keep the file so the next start can try again.
      return { repaired: false, reason: "error", error: error?.message };
    }
  }

  /** @private Put the platform back into `saved`. */
  async _applyState(saved) {
    const api = this._apis[this._platform];
    if (!api) return;
    if (this._platform === "win32") {
      await api.restore(saved);
      return;
    }
    if (saved.muted) {
      await api.setMuted(true);
      return;
    }
    await api.setVolume(saved.volume);
    await api.setMuted(false);
  }

  /**
   * Duck the system audio. Idempotent: while a duck is standing, another one is
   * a no-op rather than a second, compounding step down.
   * @param {{ mode: 'mute' | 'duck', duckLevel: number }} options
   */
  async duck({ mode, duckLevel = 0.2 } = {}) {
    return this._enqueue(() => this._doDuck({ mode, duckLevel }));
  }

  /** @private */
  async _doDuck({ mode, duckLevel }) {
    if (this._isDucked) {
      this._logger.debug("[AudioDucking] Already ducked - nothing to do");
      // A second press means whatever owns this duck is still going, so the
      // backstop should count from now rather than from the first press.
      this._armWatchdog();
      return;
    }

    try {
      const api = this._apis[this._platform];
      if (!api) {
        this._logger.debug("[AudioDucking] Unsupported platform:", this._platform);
        return;
      }

      // A state file that is still here means the last duck never got its
      // restore. Its baseline, not the lowered volume, is what this duck has to
      // work from and what the next restore has to return to.
      const previous = this._readState();

      if (this._platform === "win32") {
        // duckLevel is a multiplier - Windows duckAndSave picks the baseline
        // and computes the target inside the PS script. That same script writes
        // the crash-safe state file BEFORE it moves the volume, so there is no
        // window where the volume is down and nothing on disk says what it was.
        this._savedState = await api.duckAndSave({
          mode,
          duckLevel,
          statePath: this._stateFilePath,
          previous,
        });
        this._isDucked = true;
        this._armWatchdog();
        this._logger.debug("[AudioDucking] Ducked (Windows). Saved state:", this._savedState);
        return;
      }

      // macOS and Linux read first, so the file is written here — still before
      // anything moves.
      const current = await api.getState();
      const baseline = pickDuckBaseline(previous, current);
      if (baseline.adopted) {
        this._logger.info(
          `[AudioDucking] Last duck never restored - ducking from ${baseline.volume}, ` +
            `not from the lowered ${current.volume}`
        );
      }
      this._savedState = { volume: baseline.volume, muted: baseline.muted };
      const targetVolume = Math.max(0.01, baseline.volume * duckLevel);
      this._writeState({
        version: 1,
        mode: mode === "mute" ? "mute" : "duck",
        volume: baseline.volume,
        muted: baseline.muted,
        duckTarget: mode === "mute" ? baseline.volume : targetVolume,
        timestamp: new Date().toISOString(),
      });

      if (mode === "mute") {
        await api.setMuted(true);
      } else if (!baseline.muted) {
        await api.setVolume(targetVolume);
      }
      this._isDucked = true;
      this._armWatchdog();
      this._logger.debug(
        `[AudioDucking] Ducked (${this._platform}). Saved state:`,
        this._savedState
      );
    } catch (err) {
      // Don't let audio ducking failures crash the recording flow. The state
      // file is deliberately NOT deleted here: this is exactly the error path
      // that used to strand the volume, and the next start repairs from it.
      this._logger.error("[AudioDucking] duck() failed:", err.message, err.stack);
      console.error("[AudioDucking] duck() failed:", err.message);
    }
  }

  /**
   * Restore the system audio to what it was before ducking. Safe to call at any
   * time, as often as you like: with nothing ducked it does nothing, and a
   * restore that arrives while a duck is still running waits for that duck
   * instead of being dropped.
   */
  async restore() {
    return this._enqueue(() => this._doRestore());
  }

  /** @private */
  async _doRestore() {
    this._clearWatchdog();

    if (!this._isDucked || !this._savedState) {
      // Nothing of ours is down. If a state file is still lying around, some
      // earlier duck is still holding the volume down - finish that job rather
      // than returning and leaving it there.
      if (this._readState()) await this._repairFromDisk();
      return;
    }

    this._isDucked = false;
    const saved = this._savedState;
    this._savedState = null;

    try {
      await this._applyState(saved);
      this._logger.debug(`[AudioDucking] Restored (${this._platform}) to:`, saved);
      // Only once the volume is actually back. A restore that throws leaves the
      // file behind on purpose, so the next restore or start finishes the job.
      this._clearState();
    } catch (err) {
      this._logger.error("[AudioDucking] restore() failed:", err.message, err.stack);
      console.error("[AudioDucking] restore() failed:", err.message);
    }
  }
}

module.exports = new AudioDuckingManager();
module.exports.AudioDuckingManager = AudioDuckingManager;
module.exports.buildWindowsDuckScriptLines = buildWindowsDuckScriptLines;
module.exports.shouldRepairFromState = shouldRepairFromState;
module.exports.pickDuckBaseline = pickDuckBaseline;
module.exports.STATE_FILE_NAME = STATE_FILE_NAME;
module.exports.STILL_DUCKED_EPSILON = STILL_DUCKED_EPSILON;
module.exports.DUCK_WATCHDOG_MS = DUCK_WATCHDOG_MS;
