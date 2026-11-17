/**
 * A local AI model can finish downloading after its picker has left the
 * screen. Nothing mounted can take the selection then, so it is decided from
 * what is saved: the model is switched on only when the user is still on the
 * provider the download started under and has not picked another model since.
 *
 * @returns true when the downloaded model should become the active one
 */
export function shouldSelectDownloadedLocalModel(
  saved: { reasoningProvider: string | null; reasoningModel: string | null },
  atDownloadStart: { provider: string; model: string }
): boolean {
  const provider = saved.reasoningProvider || "";
  // "local" is the older saved value for local mode, before providers had ids.
  const sameProvider = provider === atDownloadStart.provider || provider === "local";
  const sameModel = (saved.reasoningModel || "") === (atDownloadStart.model || "");
  return sameProvider && sameModel;
}
