const fs = require("fs/promises");
const path = require("path");

const STAGES = new Set([
  "started",
  "clipboard",
  "accessibility",
  "input",
  "dispatched",
  "observed",
]);
const OUTCOMES = new Set([
  "confirmed",
  "unconfirmed",
  "missing-helper",
  "start-error",
  "exit-error",
  "timeout",
]);
const MAX_BYTES = 64 * 1024;

// Local, bounded diagnostics, independent of debug mode. Never persist raw
// helper output, error messages, paths, application names, or clipboard text.
class WindowsPasteDiagnostics {
  constructor(getDirectory) {
    this.getDirectory = getDirectory;
    this.pending = Promise.resolve();
    this.queued = 0;
  }

  record(details) {
    if (this.queued >= 32) return this.pending;
    const record = {
      time: new Date().toISOString(),
      outcome: OUTCOMES.has(details.outcome) ? details.outcome : "unconfirmed",
      stage: STAGES.has(details.stage) ? details.stage : "unknown",
      elapsedMs: Number.isFinite(details.elapsedMs)
        ? Math.max(0, Math.round(details.elapsedMs))
        : null,
      exitCode: Number.isInteger(details.exitCode) ? details.exitCode : null,
      dispatched: typeof details.dispatched === "boolean" ? details.dispatched : null,
      evidence: ["inserted", "absent", "none"].includes(details.evidence)
        ? details.evidence
        : "none",
      isTerminal: typeof details.isTerminal === "boolean" ? details.isTerminal : null,
      targetChanged: typeof details.targetChanged === "boolean" ? details.targetChanged : null,
      heldModifierCount: Number.isInteger(details.heldModifierCount)
        ? Math.max(0, Math.min(8, details.heldModifierCount))
        : null,
    };
    this.queued++;
    this.pending = this.pending
      .then(async () => {
        const directory = this.getDirectory();
        const file = path.join(directory, "windows-paste.jsonl");
        await fs.mkdir(directory, { recursive: true });
        const size = await fs.stat(file).then(
          (stat) => stat.size,
          () => 0
        );
        const line = JSON.stringify(record) + "\n";
        if (size + Buffer.byteLength(line) > MAX_BYTES) {
          await fs.rm(file + ".previous", { force: true });
          await fs.rename(file, file + ".previous");
        }
        await fs.appendFile(file, line, { mode: 0o600 });
      })
      .catch(() => {
        // An unavailable log directory must never prevent delivery.
      })
      .finally(() => {
        this.queued--;
      });
    return this.pending;
  }
}

module.exports = { WindowsPasteDiagnostics, STAGES };
