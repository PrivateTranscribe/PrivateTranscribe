"use strict";

const os = require("os");
const { execFile } = require("child_process");
const fs = require("fs");
const debugLogger = require("./debugLogger");

/**
 * How many CPU threads local Whisper should use.
 *
 * whisper.cpp's own default is min(4, hardware_concurrency), so every user got
 * 4 threads whether they had a 4-thread laptop or a 32-thread workstation. On a
 * Ryzen 9 9950X3D, raising it from 4 to 16 measured 3.4x faster on
 * large-v3-turbo and 4.9x on base - a bigger win than any GPU backend offers
 * the people who do not have an NVIDIA card.
 *
 * The auto policy is deliberately not "use everything":
 *
 *  - Physical cores, not logical. SMT siblings share execution units, and this
 *    workload already saturates them, so the second thread on a core mostly
 *    buys contention. Leaving the siblings free is also what keeps the rest of
 *    the machine usable while a dictation is being transcribed.
 *  - One core held back, but only on machines that can spare it. Giving up a
 *    core out of four costs more than the responsiveness it buys.
 *  - Capped, because the curve flattens. Past roughly 16 threads the decode is
 *    memory-bandwidth bound and extra threads mostly add scheduling noise, so
 *    a big workstation gains nothing from handing over all of it.
 *  - Never below whisper.cpp's own default. Reserving a core on a dual-core
 *    machine would have handed it 2 threads where it used to get 4, making the
 *    slowest hardware slower. This change must never be a downgrade for
 *    anyone, so the old default is the floor.
 */

const MAX_AUTO_THREADS = 16;
// whisper.cpp's own default is min(4, hardware_concurrency); used as a floor.
const WHISPER_CPP_DEFAULT_THREADS = 4;
// At or below this many physical cores, reserving one costs too large a share.
const SMALL_MACHINE_CORES = 4;
const PROBE_TIMEOUT_MS = 4000;

/** `0` (or anything unparseable) means "let the app decide". */
const AUTO = 0;

let cachedPhysicalCores = null;
let topologyProbePromise = null;

function logicalCoreCount() {
  try {
    return Math.max(1, os.cpus().length || 1);
  } catch {
    return 1;
  }
}

/**
 * The answer to fall back on when the real topology is not known yet. Assume SMT
 * on anything big enough to plausibly have it, and take the logical count at
 * face value on small machines where halving would be the more damaging guess.
 */
function estimatePhysicalCores() {
  const logical = logicalCoreCount();
  return logical > SMALL_MACHINE_CORES ? Math.max(1, Math.round(logical / 2)) : logical;
}

function runProbe(command, args) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, encoding: "utf8" },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      }
    );
  });
}

/**
 * Best-effort physical core count. Node has no API for this, so each platform
 * needs its own probe. Every failure path falls through to the estimate rather
 * than throwing: a wrong thread count is a performance question, never a reason
 * to stop transcribing.
 *
 * Asynchronous on purpose. This used to be `execFileSync("powershell", ...)`,
 * which froze the Electron main process for as long as PowerShell took to start
 * and answer — measured at 1.4s on a healthy 32-thread desktop. During that
 * freeze nothing in the app runs: no IPC, no window messages, no hotkey
 * handling, no tray. It ran on the Settings mount, so opening Settings stalled
 * the whole app.
 */
async function probePhysicalCores() {
  try {
    if (process.platform === "win32") {
      const out = await runProbe("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum",
      ]);
      const cores = Number.parseInt(String(out).trim(), 10);
      if (Number.isFinite(cores) && cores > 0) return cores;
    } else if (process.platform === "darwin") {
      const out = await runProbe("sysctl", ["-n", "hw.physicalcpu"]);
      const cores = Number.parseInt(String(out).trim(), 10);
      if (Number.isFinite(cores) && cores > 0) return cores;
    } else {
      // Linux: count distinct (physical id, core id) pairs in /proc/cpuinfo.
      const cpuinfo = await fs.promises.readFile("/proc/cpuinfo", "utf8");
      const seen = new Set();
      let physicalId = null;
      for (const line of cpuinfo.split("\n")) {
        const [rawKey, rawValue] = line.split(":");
        if (!rawValue) continue;
        const key = rawKey.trim();
        const value = rawValue.trim();
        if (key === "physical id") physicalId = value;
        if (key === "core id") seen.add(`${physicalId}/${value}`);
      }
      if (seen.size > 0) return seen.size;
    }
  } catch (error) {
    debugLogger.debug("Physical core probe failed, estimating from logical count", {
      error: error.message,
    });
  }

  return estimatePhysicalCores();
}

/**
 * Kick off the probe and cache the result. Safe to call repeatedly — concurrent
 * callers share one probe. Call it once at startup so the real number is in
 * hand long before anything asks.
 */
function warmCpuTopology() {
  if (cachedPhysicalCores !== null) {
    return Promise.resolve(cachedPhysicalCores);
  }
  if (!topologyProbePromise) {
    topologyProbePromise = probePhysicalCores()
      .then((cores) => {
        cachedPhysicalCores = cores;
        debugLogger.info("CPU topology detected", {
          physicalCores: cachedPhysicalCores,
          logicalCores: logicalCoreCount(),
        });
        return cores;
      })
      .catch(() => estimatePhysicalCores())
      .finally(() => {
        topologyProbePromise = null;
      });
  }
  return topologyProbePromise;
}

/**
 * Synchronous and never blocking. Returns the probed count once it is known and
 * the estimate until then, starting the probe on first use so a caller that
 * skipped `warmCpuTopology()` still converges on the real number.
 */
function getPhysicalCoreCount() {
  if (cachedPhysicalCores !== null) {
    return cachedPhysicalCores;
  }
  void warmCpuTopology();
  return estimatePhysicalCores();
}

/**
 * Turn the user's setting into a concrete `--threads` value.
 *
 * @param {number|string} setting `0`/unset for auto, or an explicit count.
 * @param {{physicalCores?: number, logicalCores?: number}} [topology] Injectable
 *   so the policy can be tested without a platform probe.
 * @returns {number} always at least 1, never more than the logical core count.
 */
function resolveWhisperThreads(setting, topology = {}) {
  const logical = topology.logicalCores || logicalCoreCount();

  const explicit = Number.parseInt(setting, 10);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(1, Math.min(explicit, logical));
  }

  const physical = topology.physicalCores || getPhysicalCoreCount();
  const reserved = physical > SMALL_MACHINE_CORES ? 1 : 0;
  const threads = Math.min(physical - reserved, MAX_AUTO_THREADS);

  // whisper.cpp would have picked this on its own. Going under it would make
  // the change a regression on the machines that can least afford one.
  const floor = Math.min(WHISPER_CPP_DEFAULT_THREADS, logical);

  return Math.max(1, Math.min(Math.max(threads, floor), logical));
}

/** Test seam: forget the cached probe result. */
function resetCpuTopologyCache() {
  cachedPhysicalCores = null;
  topologyProbePromise = null;
}

module.exports = {
  AUTO,
  MAX_AUTO_THREADS,
  WHISPER_CPP_DEFAULT_THREADS,
  estimatePhysicalCores,
  getPhysicalCoreCount,
  logicalCoreCount,
  resetCpuTopologyCache,
  resolveWhisperThreads,
  warmCpuTopology,
};
