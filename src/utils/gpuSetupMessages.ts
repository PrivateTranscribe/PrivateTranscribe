/**
 * Plain-language reasons for the two ways the GPU engine can fail during
 * setup: the download, and the test run on the graphics card. Setup shows the
 * reason next to a retry, so it has to say what happened in words a person
 * without a GPU background can act on, not an errno.
 */

const OFFLINE_PATTERN =
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|network|offline|socket hang up|timed out/i;
const DISK_PATTERN = /ENOSPC|no space|disk full/i;

export function describeDownloadError(
  message?: string | null,
  what: "engine" | "model" = "engine"
): string {
  const raw = (message || "").trim();
  if (!raw) return "The download stopped before it finished.";
  if (/cancel/i.test(raw)) return "You cancelled the download.";
  if (OFFLINE_PATTERN.test(raw)) {
    return "No connection to the download server. Check that this PC is online, then try again.";
  }
  if (DISK_PATTERN.test(raw)) {
    return what === "engine"
      ? "The disk is full. The GPU engine needs about 1 GB free."
      : "The disk is full. Free some space, then try again.";
  }
  if (/sha-?256|checksum|corrupt|too small/i.test(raw)) {
    return "The download arrived damaged. Trying again fetches a fresh copy.";
  }
  return `The download failed: ${raw}`;
}

type StartResult = { success?: boolean; reason?: string } | null | undefined;

type EngineStatus =
  | {
      effectiveEngine?: string;
      fallback?: {
        active?: boolean;
        diagnostic?: { kind?: string; message?: string } | null;
      };
    }
  | null
  | undefined;

export function describeGpuCheckFailure(start: StartResult, engine: EngineStatus): string {
  const diagnostic = engine?.fallback?.diagnostic;
  if (diagnostic?.kind === "blocked_by_os") {
    return "Windows blocked the GPU engine, usually Smart App Control or antivirus.";
  }
  if (diagnostic?.kind === "missing_dll_or_runtime") {
    return "A file the GPU engine needs is missing. Downloading the engine again usually fixes this.";
  }
  if (diagnostic?.message) {
    return `The GPU engine could not start on this graphics card (${diagnostic.message}). An outdated NVIDIA driver is the usual cause.`;
  }
  if (start && start.success === false) {
    return `Whisper did not start: ${start.reason || "no reason given"}.`;
  }
  return "Whisper ran on the processor instead of the graphics card. The NVIDIA driver may be too old for the GPU engine, or the card may lack memory for this model.";
}
