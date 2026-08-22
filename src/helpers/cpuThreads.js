"use strict";

const os = require("os");
const { execFileSync } = require("child_process");
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
 */

const MAX_AUTO_THREADS = 16;
// At or below this many physical cores, reserving one costs too large a share.
const SMALL_MACHINE_CORES = 4;
const PROBE_TIMEOUT_MS = 4000;

/** `0` (or anything unparseable) means "let the app decide". */
const AUTO = 0;

let cachedPhysicalCores = null;

function logicalCoreCount() {
  try {
    return Math.max(1, os.cpus().length || 1);
  } catch {
    return 1;
  }
}

/**
 * Best-effort physical core count. Node has no API for this, so each platform
 * needs its own probe. Every failure path falls through to an estimate rather
 * than throwing: a wrong thread count is a performance question, never a
 * reason to stop transcribing.
 */
function probePhysicalCores() {
  const logical = logicalCoreCount();

  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum",
        ],
        { timeout: PROBE_TIMEOUT_MS, windowsHide: true, encoding: "utf8" }
      );
      const cores = Number.parseInt(String(out).trim(), 10);
      if (Number.isFinite(cores) && cores > 0) return cores;
    } else if (process.platform === "darwin") {
      const out = execFileSync("sysctl", ["-n", "hw.physicalcpu"], {
        timeout: PROBE_TIMEOUT_MS,
        encoding: "utf8",
      });
      const cores = Number.parseInt(String(out).trim(), 10);
      if (Number.isFinite(cores) && cores > 0) return cores;
    } else {
      // Linux: count distinct (physical id, core id) pairs in /proc/cpuinfo.
      const fs = require("fs");
      const cpuinfo = fs.readFileSync("/proc/cpuinfo", "utf8");
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

  // No probe available. Assume SMT on anything big enough to plausibly have it,
  // and take the logical count at face value on small machines where halving
  // would be the more damaging guess.
  return logical > SMALL_MACHINE_CORES ? Math.max(1, Math.round(logical / 2)) : logical;
}

/** Cached because the Windows probe spawns PowerShell, which is not cheap. */
function getPhysicalCoreCount() {
  if (cachedPhysicalCores === null) {
    cachedPhysicalCores = probePhysicalCores();
    debugLogger.info("CPU topology detected", {
      physicalCores: cachedPhysicalCores,
      logicalCores: logicalCoreCount(),
    });
  }
  return cachedPhysicalCores;
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
  return Math.max(1, Math.min(threads, logical));
}

/** Test seam: forget the cached probe result. */
function resetCpuTopologyCache() {
  cachedPhysicalCores = null;
}

module.exports = {
  AUTO,
  MAX_AUTO_THREADS,
  getPhysicalCoreCount,
  logicalCoreCount,
  resetCpuTopologyCache,
  resolveWhisperThreads,
};
