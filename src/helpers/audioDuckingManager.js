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

const windows = {
  /**
   * Duck in one PowerShell call:
   *   - Outputs "volume,muted" to stdout (the current state to save)
   *   - Then applies the new level/mute
   * @returns {Promise<{ volume: number, muted: boolean }>} the state BEFORE ducking
   */
  async duckAndSave({ mode, duckLevel }) {
    // duckLevel is a multiplier (e.g. 0.5 = half of current volume).
    // The PS script reads current volume, multiplies by duckLevel, then sets.
    const setLine =
      mode === "mute"
        ? "[Audio]::SetMute($true)"
        : `$target = [Math]::Max(0.01, $vol * [float]::Parse('${duckLevel.toFixed(4)}', [System.Globalization.CultureInfo]::InvariantCulture))
[Audio]::SetVolume($target)`;

    const scriptBody = [
      // Output current state with invariant culture so no locale surprises
      "$vol = [Audio]::GetVolume()",
      "$mute = [Audio]::GetMute()",
      "Write-Output ($vol.ToString('F4', [System.Globalization.CultureInfo]::InvariantCulture) + '|' + $mute.ToString())",
      setLine,
    ].join("\n");

    const stdout = await runPs(scriptBody);
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

  /**
   * Restore in one PowerShell call.
   */
  async restore(savedState) {
    const lines = [];
    if (savedState.muted) {
      lines.push("[Audio]::SetMute($true)");
    } else {
      // Force invariant culture so locale decimal separators are not an issue
      const volStr = savedState.volume.toFixed(4); // always dot-separated in JS
      lines.push(
        `[Audio]::SetVolume([float]::Parse('${volStr}', [System.Globalization.CultureInfo]::InvariantCulture))`
      );
      lines.push("[Audio]::SetMute($false)");
    }
    await runPs(lines.join("\n"));
  },
};

// ─── AudioDuckingManager ─────────────────────────────────────────────────────

class AudioDuckingManager {
  constructor() {
    /** @type {{ volume: number, muted: boolean } | null} */
    this._savedState = null;
    this._isDucked = false;
    /** @type {Promise<void> | null} */
    this._duckInFlight = null;
    this._pendingRestore = false;
  }

  /**
   * Duck the system audio.
   * @param {{ mode: 'mute' | 'duck', duckLevel: number }} options
   */
  async duck({ mode, duckLevel = 0.2 }) {
    if (this._isDucked) {
      debugLogger.debug("[AudioDucking] Already ducked — skipping");
      return;
    }

    this._pendingRestore = false;
    const duckPromise = this._doDuck({ mode, duckLevel });
    this._duckInFlight = duckPromise;

    try {
      await duckPromise;
    } finally {
      this._duckInFlight = null;
    }

    // If restore was requested while we were ducking, do it now
    if (this._pendingRestore) {
      this._pendingRestore = false;
      debugLogger.debug("[AudioDucking] Executing deferred restore after duck completed");
      await this.restore();
    }
  }

  /** @private */
  async _doDuck({ mode, duckLevel }) {
    try {
      if (process.platform === "win32") {
        // duckLevel is a multiplier — Windows duckAndSave reads current volume
        // and computes the target inside the PS script (currentVol * duckLevel)
        this._savedState = await windows.duckAndSave({ mode, duckLevel });
        this._isDucked = true;
        debugLogger.debug("[AudioDucking] Ducked (Windows). Saved state:", this._savedState);
      } else if (process.platform === "darwin") {
        this._savedState = await macos.getState();
        if (mode === "mute") {
          await macos.setMuted(true);
        } else if (!this._savedState.muted) {
          // duckLevel is a multiplier: 0.5 = half of current volume
          const targetVolume = Math.max(0.01, this._savedState.volume * duckLevel);
          await macos.setVolume(targetVolume);
        }
        this._isDucked = true;
        debugLogger.debug("[AudioDucking] Ducked (macOS). Saved state:", this._savedState);
      } else if (process.platform === "linux") {
        this._savedState = await linux.getState();
        if (mode === "mute") {
          await linux.setMuted(true);
        } else if (!this._savedState.muted) {
          // duckLevel is a multiplier: 0.5 = half of current volume
          const targetVolume = Math.max(0.01, this._savedState.volume * duckLevel);
          await linux.setVolume(targetVolume);
        }
        this._isDucked = true;
        debugLogger.debug("[AudioDucking] Ducked (Linux). Saved state:", this._savedState);
      } else {
        debugLogger.debug("[AudioDucking] Unsupported platform:", process.platform);
      }
    } catch (err) {
      // Don't let audio ducking failures crash the recording flow
      debugLogger.error("[AudioDucking] duck() failed:", err.message, err.stack);
      console.error("[AudioDucking] duck() failed:", err.message);
    }
  }

  /**
   * Restore the system audio to what it was before ducking.
   */
  async restore() {
    // If a duck is still in flight, defer the restore
    if (this._duckInFlight) {
      debugLogger.debug("[AudioDucking] Duck in flight — deferring restore");
      this._pendingRestore = true;
      return;
    }

    if (!this._isDucked || !this._savedState) return;

    this._isDucked = false;
    const saved = this._savedState;
    this._savedState = null;

    try {
      if (process.platform === "win32") {
        await windows.restore(saved);
        debugLogger.debug("[AudioDucking] Restored (Windows) to:", saved);
      } else if (process.platform === "darwin") {
        if (saved.muted) {
          await macos.setMuted(true);
        } else {
          await macos.setVolume(saved.volume);
          await macos.setMuted(false);
        }
        debugLogger.debug("[AudioDucking] Restored (macOS) to:", saved);
      } else if (process.platform === "linux") {
        if (saved.muted) {
          await linux.setMuted(true);
        } else {
          await linux.setVolume(saved.volume);
          await linux.setMuted(false);
        }
        debugLogger.debug("[AudioDucking] Restored (Linux) to:", saved);
      }
    } catch (err) {
      debugLogger.error("[AudioDucking] restore() failed:", err.message, err.stack);
      console.error("[AudioDucking] restore() failed:", err.message);
    }
  }
}

module.exports = new AudioDuckingManager();
