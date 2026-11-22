export type CudaCardDownloadState = "idle" | "downloading" | "done" | "error";

/**
 * What a GPU engine card shows for one broadcast progress event. The events
 * reach every window, also for a download the card did not start (the silent
 * startup update, the other card), so the card follows them to the end: the
 * last event is "done", "failed" or "cancelled".
 */
export function cardStateForCudaProgress(
  phase: string | undefined,
  error?: string | null
): { state: CudaCardDownloadState; error: string | null } {
  if (phase === "done") return { state: "done", error: null };
  if (phase === "failed") return { state: "error", error: error || "GPU engine download failed" };
  if (phase === "cancelled") return { state: "idle", error: null };
  return { state: "downloading", error: null };
}
