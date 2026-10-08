"use strict";

/**
 * Whether this PC's hardware is good enough to run Parakeet on the CPU.
 *
 * This is the cheap first gate only. A short speed test and a spoken-language
 * check happen later in setup, so an unknown answer here passes rather than
 * locking out a machine that would have been fine.
 */

const GIB = 1024 ** 3;

const MIN_PHYSICAL_CORES = 4;
// An "8 GB" laptop reports less than 8 GiB because firmware and the integrated
// GPU reserve part of it, so the bar sits just under.
const MIN_TOTAL_MEMORY_BYTES = 7.5 * GIB;

// Rounded down, so a machine just under the bar never reads as meeting it.
function formatGb(bytes) {
  return `${Math.floor((bytes / GIB) * 10 + 1e-9) / 10} GB`;
}

/**
 * @param {{ physicalCores?: number|null, avx2?: boolean|null, totalBytes?: number|null,
 *   logicalCores?: number|null }} hardware
 * @returns {{ eligible: boolean, reasons: string[] }} `reasons` holds one
 *   end-user sentence per failed rule and is empty when eligible.
 */
function evaluateParakeetHardware({ physicalCores, avx2, totalBytes, logicalCores } = {}) {
  const reasons = [];

  // Without a physical count, assume two threads per core. That under-counts a
  // CPU without SMT, which errs towards keeping Parakeet off slow machines.
  const cores =
    Number.isFinite(physicalCores) && physicalCores > 0
      ? physicalCores
      : Number.isFinite(logicalCores) && logicalCores > 0
        ? Math.floor(logicalCores / 2)
        : null;

  if (cores === null) {
    reasons.push("Could not count this PC's processor cores.");
  } else if (cores < MIN_PHYSICAL_CORES) {
    reasons.push(
      `Needs a processor with at least ${MIN_PHYSICAL_CORES} cores. This PC has ${cores}.`
    );
  }

  if (avx2 === false) {
    reasons.push("Needs a newer processor (AVX2 support).");
  }

  if (Number.isFinite(totalBytes) && totalBytes > 0 && totalBytes < MIN_TOTAL_MEMORY_BYTES) {
    reasons.push(`Needs 8 GB of memory. This PC has ${formatGb(totalBytes)}.`);
  }

  return { eligible: reasons.length === 0, reasons };
}

module.exports = {
  MIN_PHYSICAL_CORES,
  MIN_TOTAL_MEMORY_BYTES,
  evaluateParakeetHardware,
};
