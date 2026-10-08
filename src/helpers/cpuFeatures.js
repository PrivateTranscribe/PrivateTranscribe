"use strict";

const childProcess = require("child_process");
const debugLogger = require("./debugLogger");

/**
 * Processor instruction-set checks that Node cannot answer on its own.
 *
 * Parakeet's CPU inference leans on AVX2; a processor without it runs the model
 * far too slowly for dictation. Every answer here is `true`, `false`, or `null`
 * for "could not tell", and nothing throws: an unknown answer is the caller's
 * call to make, never a reason to fail hardware detection.
 */

// PF_AVX2_INSTRUCTIONS_AVAILABLE from winnt.h.
const PF_AVX2_INSTRUCTIONS_AVAILABLE = 40;
const PROBE_TIMEOUT_MS = 5000;

// kernel32-only on purpose: user32 P/Invoke from PowerShell has been flagged by
// AMSI in this repo before, while kernel32 calls already ship without trouble.
const AVX2_SCRIPT =
  "Add-Type -Namespace PT -Name Cpu -MemberDefinition " +
  "'[DllImport(\"kernel32.dll\")] public static extern bool IsProcessorFeaturePresent(uint f);'; " +
  `[PT.Cpu]::IsProcessorFeaturePresent(${PF_AVX2_INSTRUCTIONS_AVAILABLE})`;

let cachedAvx2 = null;
let avx2ProbePromise = null;

/**
 * Asynchronous so the probe never blocks the Electron main process while
 * PowerShell starts. Rejects on non-zero exit, missing binary, or timeout.
 */
function runPowerShell(script, { timeout = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-Command",
        script,
      ],
      { timeout, windowsHide: true, encoding: "utf8" },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      }
    );
  });
}

/** PowerShell prints a [bool] as `True` or `False`; anything else is unknown. */
function parseBooleanOutput(stdout) {
  const text = String(stdout ?? "").trim();
  if (/^true$/i.test(text)) return true;
  if (/^false$/i.test(text)) return false;
  return null;
}

async function probeAvx2() {
  if (process.platform !== "win32") return null;

  try {
    const stdout = await internals.runPowerShell(AVX2_SCRIPT, { timeout: PROBE_TIMEOUT_MS });
    const result = parseBooleanOutput(stdout);
    if (result === null) {
      debugLogger.debug("AVX2 probe returned unexpected output", {
        output: String(stdout ?? "").slice(0, 200),
      });
    }
    return result;
  } catch (error) {
    debugLogger.debug("AVX2 probe failed", { error: error?.message });
    return null;
  }
}

/**
 * Whether the processor supports AVX2. A definite answer is cached for the
 * process lifetime; `null` is not, so a probe that timed out under startup load
 * gets another chance on the next hardware re-detect.
 *
 * @returns {Promise<boolean|null>}
 */
function detectAvx2() {
  if (cachedAvx2 !== null) return Promise.resolve(cachedAvx2);

  if (!avx2ProbePromise) {
    avx2ProbePromise = probeAvx2()
      .then((result) => {
        if (result !== null) cachedAvx2 = result;
        return result;
      })
      .catch(() => null)
      .finally(() => {
        avx2ProbePromise = null;
      });
  }
  return avx2ProbePromise;
}

/** Test seam: forget the cached probe result. */
function resetCpuFeaturesCache() {
  cachedAvx2 = null;
  avx2ProbePromise = null;
}

// Calls go through this object so tests can spy on the spawn wrapper; vi.mock
// cannot reach a CommonJS require inside src/helpers.
const internals = { runPowerShell };

module.exports = {
  AVX2_SCRIPT,
  PF_AVX2_INSTRUCTIONS_AVAILABLE,
  PROBE_TIMEOUT_MS,
  detectAvx2,
  internals,
  parseBooleanOutput,
  resetCpuFeaturesCache,
};
