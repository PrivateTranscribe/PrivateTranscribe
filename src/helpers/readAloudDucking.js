/**
 * Quiet every OTHER app while Read Aloud is speaking.
 *
 * Why this is not audioDuckingManager
 * -----------------------------------
 * audioDuckingManager lowers the MASTER volume, which is exactly the wrong
 * tool here: master sits above every session, so it would quiet the voice we
 * are trying to make audible along with everything else. Windows also gives no
 * way to push one app above master — a session volume is a 0..1 multiplier
 * UNDER it and can never exceed it — so "make PrivateTranscribe louder instead"
 * genuinely is not available. Lowering every other session and leaving master
 * (and our own sessions) alone is the only mechanism that ends with the read at
 * full loudness. audioDuckingManager stays exactly as it is, for transcription.
 *
 * Mechanism (Windows only)
 * ------------------------
 * Core Audio session volumes:
 *   IMMDeviceEnumerator -> GetDefaultAudioEndpoint(eRender, eMultimedia)
 *   -> IAudioSessionManager2 -> IAudioSessionEnumerator
 *   -> per session IAudioSessionControl2 (pid, instance id)
 *   -> ISimpleAudioVolume (get/set that session's own level)
 *
 * The COM work happens in a C# type compiled by Add-Type inside a PowerShell
 * child process, the same shape audioDuckingManager uses. Its hard-won rules
 * apply here too and then some, because these interfaces are deeper:
 *   - Every vtable slot must be declared, in order, even the ones we never
 *     call: a missing stub silently shifts every method after it.
 *   - IAudioSessionControl2 is declared FLAT (its nine inherited
 *     IAudioSessionControl slots repeated first) because C# interface
 *     inheritance does not reproduce a COM vtable.
 *   - LPCGUID event-context parameters are `ref System.Guid` (a pointer), not
 *     a by-value Guid.
 *   - LPWSTR out-parameters come back as IntPtr and are freed with
 *     Marshal.FreeCoTaskMem.
 *   - Interfaces are `public` because a public static class exposes them.
 *
 * Own-process exclusion
 * ---------------------
 * The caller injects the full PID set to leave alone: process.pid plus every
 * entry from Electron's app.getAppMetrics(), because playback lives in a
 * renderer and its audio session belongs to that renderer's PID, not to main.
 * PID 0 and the system-sounds session are skipped as well.
 *
 * Crash safety
 * ------------
 * The restore list is written to disk BEFORE any volume moves (the C# does the
 * write itself, between its collect pass and its apply pass) and is deleted
 * only after a successful restore. If the app is killed mid-read, the next
 * start finds the file and puts the other apps back — the same stranded-volume
 * failure Kristian hit with the master-volume duck.
 *
 * Known limits, recorded rather than hidden:
 *   - Sessions are enumerated once, at the start of a read. An app that starts
 *     playing halfway through is not ducked.
 *   - Only the default render endpoint is enumerated. Audio on a second output
 *     device is out of scope.
 *
 * Dependencies are constructor-injected because vitest cannot mock a CommonJS
 * `require("electron")` inside src/helpers; a unit test hands in fakes rather
 * than replacing the module.
 */

const os = require("os");
const nodeFs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const debugLogger = require("./debugLogger");

/** Every other app drops to this fraction of its own current level. */
const DEFAULT_DUCK_FRACTION = 0.3;

/** Set by the e2e fixture so a test run never touches the machine's audio. */
const DIAG_DISABLE_FLAG = "PRIVATETRANSCRIBE_DIAG_DISABLE_AUDIO_DUCKING";

const STATE_FILE_NAME = "readaloud-ducking-state.txt";

/**
 * The state file is plain lines, not JSON, for one reason: the C# writes it,
 * and a session instance identifier is full of backslashes and pipes. Lines of
 * `pid|priorVolume|duckedVolume|instanceId` with the id last need no escaping
 * at all, and parse with the same function as the script's stdout.
 */
const STATE_HEADER = "# readaloud-ducking v1";

const isDiagFlagEnabled = (name) => {
  const raw = String(process.env[name] || "")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
};

// ─── The C# that does the actual COM work ────────────────────────────────────

const SESSION_CS = `
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Globalization;

[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ISimpleAudioVolume {
  int SetMasterVolume(float fLevel, ref System.Guid EventContext);
  int GetMasterVolume(out float pfLevel);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref System.Guid EventContext);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
}

[Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionControl {
  int GetState(out int pRetVal);
  int GetDisplayName(out IntPtr pRetVal);
  int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string Value, ref System.Guid EventContext);
  int GetIconPath(out IntPtr pRetVal);
  int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string Value, ref System.Guid EventContext);
  int GetGroupingParam(out System.Guid pRetVal);
  int SetGroupingParam(ref System.Guid Override, ref System.Guid EventContext);
  int RegisterAudioSessionNotification(IntPtr NewNotifications);
  int UnregisterAudioSessionNotification(IntPtr NewNotifications);
}

// Flat on purpose: the nine IAudioSessionControl slots come first in the real
// vtable, and C# interface inheritance would not reproduce them.
[Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionControl2 {
  int GetState(out int pRetVal);
  int GetDisplayName(out IntPtr pRetVal);
  int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string Value, ref System.Guid EventContext);
  int GetIconPath(out IntPtr pRetVal);
  int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string Value, ref System.Guid EventContext);
  int GetGroupingParam(out System.Guid pRetVal);
  int SetGroupingParam(ref System.Guid Override, ref System.Guid EventContext);
  int RegisterAudioSessionNotification(IntPtr NewNotifications);
  int UnregisterAudioSessionNotification(IntPtr NewNotifications);
  int GetSessionIdentifier(out IntPtr pRetVal);
  int GetSessionInstanceIdentifier(out IntPtr pRetVal);
  int GetProcessId(out uint pRetVal);
  // Explicit [PreserveSig] because this one returns a MEANINGFUL HRESULT
  // (S_OK = yes, S_FALSE = no) rather than a status, and without it the
  // marshaller hands back 0 for every session.
  [PreserveSig] int IsSystemSoundsSession();
  int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
}

[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionEnumerator {
  int GetCount(out int SessionCount);
  int GetSession(int SessionCount, out IAudioSessionControl Session);
}

[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionManager2 {
  int GetAudioSessionControlStub();   // IAudioSessionManager slot 1
  int GetSimpleAudioVolumeStub();     // IAudioSessionManager slot 2
  int GetSessionEnumerator(out IAudioSessionEnumerator SessionEnum);
  // RegisterSessionNotification and everything below it is never called.
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceS {
  int Activate(ref System.Guid id, uint clsCtx, IntPtr pActivationParams,
    [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumeratorS {
  int EnumAudioEndpointsStub();
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDeviceS ppDevice);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumeratorComObjectS {}

public static class AudioSessions {
  // Held for the process lifetime so the enumerator never outlives the manager
  // that produced it.
  static IAudioSessionManager2 _manager;

  static IAudioSessionEnumerator Enumerate() {
    var enumerator = new MMDeviceEnumeratorComObjectS() as IMMDeviceEnumeratorS;
    IMMDeviceS dev;
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out dev)); // eRender, eMultimedia
    object mgrObj;
    var iid = typeof(IAudioSessionManager2).GUID;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out mgrObj)); // CLSCTX_ALL
    _manager = mgrObj as IAudioSessionManager2;
    IAudioSessionEnumerator sessions;
    Marshal.ThrowExceptionForHR(_manager.GetSessionEnumerator(out sessions));
    return sessions;
  }

  static string InstanceId(IAudioSessionControl2 c2) {
    IntPtr p;
    if (c2.GetSessionInstanceIdentifier(out p) != 0 || p == IntPtr.Zero) return null;
    string s = Marshal.PtrToStringUni(p);
    Marshal.FreeCoTaskMem(p);
    return s;
  }

  static string F(float v) { return v.ToString("F4", CultureInfo.InvariantCulture); }

  // Every row puts the instance id LAST and never splits on it, because a
  // session instance identifier legitimately contains '|' characters.

  /** Every session on the default render endpoint: pid|volume|state|sysSounds|id */
  public static string[] List() {
    var rows = new List<string>();
    var e = Enumerate();
    int count;
    Marshal.ThrowExceptionForHR(e.GetCount(out count));
    for (int i = 0; i < count; i++) {
      IAudioSessionControl ctl;
      if (e.GetSession(i, out ctl) != 0) continue;
      var c2 = ctl as IAudioSessionControl2;
      var sv = ctl as ISimpleAudioVolume;
      if (c2 == null || sv == null) continue;
      uint pid; if (c2.GetProcessId(out pid) != 0) pid = 0;
      int state; if (c2.GetState(out state) != 0) state = -1;
      float vol; if (sv.GetMasterVolume(out vol) != 0) continue;
      bool sys = (c2.IsSystemSoundsSession() == 0);
      string id = InstanceId(c2);
      if (id == null) continue;
      rows.Add(pid.ToString(CultureInfo.InvariantCulture) + "|" + F(vol) + "|" +
        state.ToString(CultureInfo.InvariantCulture) + "|" + (sys ? "1" : "0") + "|" + id);
    }
    return rows.ToArray();
  }

  /** One session's current level by instance id, or "-1" when it is gone. */
  public static string Peek(string instanceId) {
    var e = Enumerate();
    int count;
    Marshal.ThrowExceptionForHR(e.GetCount(out count));
    for (int i = 0; i < count; i++) {
      IAudioSessionControl ctl;
      if (e.GetSession(i, out ctl) != 0) continue;
      var c2 = ctl as IAudioSessionControl2;
      var sv = ctl as ISimpleAudioVolume;
      if (c2 == null || sv == null) continue;
      string id = InstanceId(c2);
      if (id == null || !string.Equals(id, instanceId, StringComparison.Ordinal)) continue;
      float vol;
      if (sv.GetMasterVolume(out vol) != 0) return "-1";
      return F(vol);
    }
    return "-1";
  }

  /**
   * Multiply every session NOT in excludePids by fraction.
   *
   * Two passes on purpose. The first collects the candidates and their current
   * levels and writes the restore list to statePath; only then does the second
   * pass move a single volume. That ordering is what makes a kill mid-read
   * recoverable: the file always describes a state at least as ducked as
   * reality, and restoring a session that was never actually ducked just sets
   * it to the level it already has.
   *
   * Returns one "pid|priorVolume|duckedVolume|instanceId" line per session it
   * actually changed.
   */
  public static string[] DuckOthers(int[] excludePids, float fraction, string statePath, string header) {
    var skip = new HashSet<int>(excludePids ?? new int[0]);
    var context = System.Guid.Empty;
    var e = Enumerate();
    int count;
    Marshal.ThrowExceptionForHR(e.GetCount(out count));

    var vols = new List<ISimpleAudioVolume>();
    var rows = new List<string>();
    var targets = new List<float>();

    for (int i = 0; i < count; i++) {
      IAudioSessionControl ctl;
      if (e.GetSession(i, out ctl) != 0) continue;
      var c2 = ctl as IAudioSessionControl2;
      var sv = ctl as ISimpleAudioVolume;
      if (c2 == null || sv == null) continue;
      uint pidU;
      if (c2.GetProcessId(out pidU) != 0) continue;
      int pid = (int)pidU;
      if (pid == 0) continue;                        // unowned / system
      if (c2.IsSystemSoundsSession() == 0) continue; // S_OK means it IS system sounds
      if (skip.Contains(pid)) continue;              // our own process tree
      int state;
      if (c2.GetState(out state) != 0) continue;
      if (state == 2) continue;                      // AudioSessionStateExpired
      float vol;
      if (sv.GetMasterVolume(out vol) != 0) continue;
      string id = InstanceId(c2);
      if (id == null) continue;
      float target = vol * fraction;
      if (target < 0f) target = 0f;
      vols.Add(sv);
      targets.Add(target);
      rows.Add(pid.ToString(CultureInfo.InvariantCulture) + "|" + F(vol) + "|" + F(target) + "|" + id);
    }

    if (!string.IsNullOrEmpty(statePath)) {
      var lines = new List<string>();
      lines.Add(header + " " + DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) +
        " fraction=" + F(fraction));
      lines.AddRange(rows);
      System.IO.File.WriteAllLines(statePath, lines.ToArray(), new System.Text.UTF8Encoding(false));
    }

    var ducked = new List<string>();
    for (int k = 0; k < vols.Count; k++) {
      if (vols[k].SetMasterVolume(targets[k], ref context) != 0) continue;
      ducked.Add(rows[k]);
    }
    return ducked.ToArray();
  }

  /** Put the listed sessions back. Missing ones (process gone) are skipped. */
  public static int RestoreSessions(string[] ids, float[] volumes) {
    if (ids == null || ids.Length == 0) return 0;
    int restored = 0;
    var context = System.Guid.Empty;
    var e = Enumerate();
    int count;
    Marshal.ThrowExceptionForHR(e.GetCount(out count));
    for (int i = 0; i < count; i++) {
      IAudioSessionControl ctl;
      if (e.GetSession(i, out ctl) != 0) continue;
      var c2 = ctl as IAudioSessionControl2;
      var sv = ctl as ISimpleAudioVolume;
      if (c2 == null || sv == null) continue;
      string id = InstanceId(c2);
      if (id == null) continue;
      for (int k = 0; k < ids.Length; k++) {
        if (!string.Equals(ids[k], id, StringComparison.Ordinal)) continue;
        if (sv.SetMasterVolume(volumes[k], ref context) == 0) restored++;
        break;
      }
    }
    return restored;
  }
}
`.trim();

/** PowerShell single-quoted string literal: only ' needs escaping. */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Invariant decimal, so a Danish locale never turns 0.3 into 0,3. */
function psFloat(value) {
  return `[float]::Parse('${Number(value).toFixed(4)}', [System.Globalization.CultureInfo]::InvariantCulture)`;
}

/**
 * Default runner: write a .ps1 into the temp dir and execute it. A script file
 * avoids every -Command quoting and newline hazard, exactly as
 * audioDuckingManager does. The filename is distinct from that module's so the
 * two can never clobber each other's script mid-write.
 */
function defaultRunPowerShell(scriptBody, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(os.tmpdir(), "privatetranscribe_session_duck.ps1");
    const fullScript = ['Add-Type -TypeDefinition @"', SESSION_CS, '"@', "", scriptBody].join("\n");

    nodeFs.writeFile(scriptPath, fullScript, "utf8", (writeErr) => {
      if (writeErr) return reject(writeErr);
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        { windowsHide: true, timeout },
        (err, stdout, stderr) => {
          if (err) {
            if (stderr) debugLogger.error("[ReadAloudDucking] PS stderr:", String(stderr).trim());
            return reject(err);
          }
          if (stderr && String(stderr).trim()) {
            debugLogger.debug("[ReadAloudDucking] PS stderr:", String(stderr).trim());
          }
          resolve(String(stdout).trim());
        }
      );
    });
  });
}

// ─── Pure decisions, kept out of PowerShell so they can be unit tested ───────

/**
 * The PID set the duck must leave alone: our own main process plus every
 * process Electron reports for this app (renderers, GPU, utility). Deduped,
 * integers only, PID 0 dropped — it is never a real owner.
 */
function buildExcludedPids(ownPid, metrics) {
  const out = new Set();
  const add = (value) => {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) out.add(n);
  };
  add(ownPid);
  for (const entry of Array.isArray(metrics) ? metrics : []) {
    add(entry && typeof entry === "object" ? entry.pid : entry);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The same rule the C# applies, expressed once in JS so a test can pin it: a
 * session is duckable when it has a real owner that is not us, is not the
 * system-sounds session, and has not expired.
 */
function shouldDuckSession(session, excludedPids) {
  if (!session) return false;
  const pid = Number(session.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (session.systemSounds) return false;
  if (session.state === 2) return false;
  return !new Set(excludedPids || []).has(pid);
}

/** Which of the enumerated sessions this duck is allowed to touch. */
function selectDuckableSessions(sessions, excludedPids) {
  return (Array.isArray(sessions) ? sessions : []).filter((s) =>
    shouldDuckSession(s, excludedPids)
  );
}

/** Parse `AudioSessions::List()` output into objects. */
function parseSessionList(stdout) {
  const rows = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // pid|volume|state|systemSounds|instanceId — the id is everything after the
    // fourth separator, because it contains separators of its own.
    const parts = trimmed.split("|");
    if (parts.length < 5) continue;
    rows.push({
      pid: Number.parseInt(parts[0], 10),
      volume: Number.parseFloat(parts[1]),
      state: Number.parseInt(parts[2], 10),
      systemSounds: parts[3] === "1",
      instanceId: parts.slice(4).join("|"),
    });
  }
  return rows;
}

/**
 * Parse `AudioSessions::DuckOthers()` output — and the state file, which is
 * deliberately the same format — into the restore list.
 */
function parseDuckedList(stdout) {
  const rows = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split("|");
    if (parts.length < 4) continue;
    const pid = Number.parseInt(parts[0], 10);
    const prior = Number.parseFloat(parts[1]);
    const ducked = Number.parseFloat(parts[2]);
    if (!Number.isFinite(prior)) continue;
    rows.push({
      pid,
      // Kept as invariant text: PowerShell stringifies a number with the
      // machine's locale, which on a Danish machine is "0,8000".
      priorVolume: prior.toFixed(4),
      duckedVolume: Number.isFinite(ducked) ? ducked.toFixed(4) : prior.toFixed(4),
      instanceId: parts.slice(3).join("|"),
    });
  }
  return rows;
}

/** Serialise a restore list back into the on-disk format. */
function serializeState(sessions, fraction) {
  const lines = [
    `${STATE_HEADER} ${new Date().toISOString()} fraction=${Number(fraction).toFixed(4)}`,
  ];
  for (const s of sessions) {
    lines.push(`${s.pid}|${s.priorVolume}|${s.duckedVolume}|${s.instanceId}`);
  }
  return `${lines.join("\n")}\n`;
}

// ─── The manager ─────────────────────────────────────────────────────────────

class ReadAloudDucking {
  constructor({
    platform = process.platform,
    logger = debugLogger,
    fs = nodeFs,
    runPowerShell = defaultRunPowerShell,
    getExcludedPids = () => [process.pid],
    stateFilePath = null,
    duckFraction = DEFAULT_DUCK_FRACTION,
  } = {}) {
    this.platform = platform;
    this.logger = logger;
    this.fs = fs;
    this.runPowerShell = runPowerShell;
    this.getExcludedPids = getExcludedPids;
    this.stateFilePath = stateFilePath;
    this.duckFraction = duckFraction;
    /** @type {{pid:number,instanceId:string,priorVolume:string,duckedVolume:string}[]|null} */
    this.saved = null;
    this.ducked = false;
    /**
     * Diagnostic counters, surfaced through the playback-active IPC reply.
     *
     * `duckRequests`/`restoreRequests` count what the IPC handler ASKED for and
     * are incremented before any platform or diagnostic-flag check, so an e2e
     * run can prove the wiring on a machine where the real PowerShell calls are
     * switched off. `duckCalls`/`restoreCalls` count what actually ran.
     */
    this.stats = {
      duckRequests: 0,
      restoreRequests: 0,
      duckCalls: 0,
      restoreCalls: 0,
      repairs: 0,
      lastReason: null,
    };
    this._inFlight = null;
  }

  /** Late-bind what only main.js knows: the userData dir and the app's PIDs. */
  configure({ userDataPath, stateFilePath, getExcludedPids } = {}) {
    if (stateFilePath) this.stateFilePath = stateFilePath;
    else if (userDataPath) this.stateFilePath = path.join(userDataPath, STATE_FILE_NAME);
    if (typeof getExcludedPids === "function") this.getExcludedPids = getExcludedPids;
    return this.stateFilePath;
  }

  get supported() {
    return this.platform === "win32";
  }

  getStatus() {
    return {
      supported: this.supported,
      ducked: this.ducked,
      sessions: this.saved ? this.saved.length : 0,
      ...this.stats,
    };
  }

  /** Everything that would touch the machine's audio funnels through here. */
  _blocked() {
    if (!this.supported) {
      this.stats.lastReason = "unsupported-platform";
      this.logger.debug?.(
        `[ReadAloudDucking] No per-app ducking on ${this.platform}; other apps left alone`
      );
      return true;
    }
    if (isDiagFlagEnabled(DIAG_DISABLE_FLAG)) {
      this.stats.lastReason = "diagnostic-flag";
      this.logger.debug?.("[ReadAloudDucking] Skipping (diagnostic flag)");
      return true;
    }
    return false;
  }

  _readState() {
    if (!this.stateFilePath) return null;
    try {
      if (!this.fs.existsSync(this.stateFilePath)) return null;
      const sessions = parseDuckedList(this.fs.readFileSync(this.stateFilePath, "utf8"));
      return { sessions };
    } catch (error) {
      this.logger.warn?.("[ReadAloudDucking] Unreadable state file", { error: error?.message });
      return null;
    }
  }

  _writeState(sessions) {
    if (!this.stateFilePath) return;
    try {
      this.fs.writeFileSync(
        this.stateFilePath,
        serializeState(sessions, this.duckFraction),
        "utf8"
      );
    } catch (error) {
      this.logger.warn?.("[ReadAloudDucking] Could not write state file", {
        error: error?.message,
      });
    }
  }

  _clearState() {
    if (!this.stateFilePath) return;
    try {
      if (this.fs.existsSync(this.stateFilePath)) this.fs.unlinkSync(this.stateFilePath);
    } catch (error) {
      this.logger.warn?.("[ReadAloudDucking] Could not delete state file", {
        error: error?.message,
      });
    }
  }

  /** The whole session list, for diagnostics and the live check. */
  async listSessions() {
    if (this._blocked()) return [];
    const stdout = await this.runPowerShell(
      "foreach ($row in [AudioSessions]::List()) { Write-Output $row }"
    );
    return parseSessionList(stdout);
  }

  /**
   * Drop every other app's session to `duckFraction` of its current level.
   * Idempotent: a second call while already ducked does nothing, so an overlay
   * that re-reports "active" can never duck an already-ducked session twice.
   */
  async duckOthers() {
    this.stats.duckRequests += 1;
    if (this.ducked || this._inFlight) return this.getStatus();
    if (this._blocked()) return this.getStatus();

    const run = this._doDuck();
    this._inFlight = run;
    try {
      await run;
    } finally {
      this._inFlight = null;
    }
    return this.getStatus();
  }

  /** @private */
  async _doDuck() {
    this.stats.duckCalls += 1;
    try {
      const excluded = this.getExcludedPids() || [];
      const body = [
        `$excluded = [int[]]@(${excluded.join(",")})`,
        `$rows = [AudioSessions]::DuckOthers($excluded, ${psFloat(this.duckFraction)}, ${psQuote(
          this.stateFilePath || ""
        )}, ${psQuote(STATE_HEADER)})`,
        "foreach ($row in $rows) { Write-Output $row }",
      ].join("\n");

      const stdout = await this.runPowerShell(body);
      const sessions = parseDuckedList(stdout);

      // The C# already wrote the file before it touched a volume; this rewrite
      // narrows it from "candidates" to "actually changed", which is a strict
      // subset, so the window is never widened.
      this._writeState(sessions);
      this.saved = sessions;
      this.ducked = true;
      this.stats.lastReason = null;
      this.logger.debug?.(
        `[ReadAloudDucking] Ducked ${sessions.length} other session(s) to ${this.duckFraction}`,
        { excluded }
      );
    } catch (error) {
      this.stats.lastReason = "duck-failed";
      this.logger.error?.("[ReadAloudDucking] duck failed", { error: error?.message });
      // The C# may have written the file and died partway through applying, so
      // the file is left alone on purpose — the next start repairs from it.
    }
  }

  /** Put every ducked session back to the exact level it had. */
  async restore() {
    this.stats.restoreRequests += 1;
    if (this._inFlight) {
      // A restore that lands mid-duck would restore nothing; wait it out.
      try {
        await this._inFlight;
      } catch {
        // _doDuck swallows its own errors; nothing to add here.
      }
    }
    if (!this.ducked) return this.getStatus();

    const sessions = this.saved || [];
    this.ducked = false;
    this.saved = null;
    this.stats.restoreCalls += 1;

    await this._restoreSessions(sessions, "read ended");
    return this.getStatus();
  }

  /** @private Shared by the live path and the crash repair. */
  async _restoreSessions(sessions, why) {
    if (!sessions.length || this._blocked()) {
      this._clearState();
      return 0;
    }
    try {
      const idList = sessions.map((s) => psQuote(s.instanceId)).join(",");
      const volList = sessions
        .map(
          (s) =>
            `[float]::Parse('${s.priorVolume}', [System.Globalization.CultureInfo]::InvariantCulture)`
        )
        .join(",");
      const body = [
        `$ids = [string[]]@(${idList})`,
        `$vols = [float[]]@(${volList})`,
        "$n = [AudioSessions]::RestoreSessions($ids, $vols)",
        'Write-Output ("restored=" + $n)',
      ].join("\n");

      const stdout = await this.runPowerShell(body);
      const restored = Number.parseInt(String(stdout).replace(/[^0-9]/g, ""), 10) || 0;
      this.logger.debug?.(
        `[ReadAloudDucking] Restored ${restored}/${sessions.length} session(s) (${why})`
      );
      // Only once the restore actually happened.
      this._clearState();
      return restored;
    } catch (error) {
      this.stats.lastReason = "restore-failed";
      this.logger.error?.("[ReadAloudDucking] restore failed", { error: error?.message, why });
      // Deliberately keep the file: the next start gets another go at it.
      return 0;
    }
  }

  /**
   * Called once at startup. A state file here means a previous run was killed
   * mid-read and somebody's music is still sitting at 30%.
   */
  async repairFromDisk() {
    const state = this._readState();
    if (!state) return { repaired: false, reason: "no-state-file" };

    if (!this.supported) {
      this._clearState();
      this.logger.debug?.("[ReadAloudDucking] Dropped a stale state file on a non-Windows run");
      return { repaired: false, reason: "unsupported-platform" };
    }

    this.stats.repairs += 1;
    const restored = await this._restoreSessions(
      state.sessions,
      "previous run ended mid-read (crash repair)"
    );
    this.logger.info?.(
      `[ReadAloudDucking] Crash repair: put ${restored}/${state.sessions.length} session(s) back`
    );
    return { repaired: true, restored, total: state.sessions.length };
  }
}

module.exports = ReadAloudDucking;
module.exports.ReadAloudDucking = ReadAloudDucking;
module.exports.buildExcludedPids = buildExcludedPids;
module.exports.shouldDuckSession = shouldDuckSession;
module.exports.selectDuckableSessions = selectDuckableSessions;
module.exports.parseSessionList = parseSessionList;
module.exports.parseDuckedList = parseDuckedList;
module.exports.serializeState = serializeState;
module.exports.DEFAULT_DUCK_FRACTION = DEFAULT_DUCK_FRACTION;
module.exports.STATE_FILE_NAME = STATE_FILE_NAME;
module.exports.STATE_HEADER = STATE_HEADER;
module.exports.DIAG_DISABLE_FLAG = DIAG_DISABLE_FLAG;
module.exports.SESSION_CS = SESSION_CS;
