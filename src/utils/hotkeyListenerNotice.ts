/**
 * The notice for a "windows-ptt-unavailable" message from the main process.
 * The listener that watches the hotkey on Windows restarts itself twice after
 * a crash; this message comes when that did not help, or when it cannot watch
 * the chosen hotkey at all. Without a notice, Hold and Both modes just stopped.
 *
 * A missing listener binary ("binary_not_found") gets no notice: it is a
 * developer build without compiled helpers, not something a user can fix.
 */
export function getHotkeyListenerNotice(
  data: { reason?: string; kind?: string } | null | undefined
): { title: string; description: string } | null {
  if (data?.reason !== "error") return null;
  if (data.kind === "bad_hotkey") {
    return {
      title: "Hotkey not supported",
      description: "PrivateTranscribe cannot watch this hotkey. Choose another one in Settings.",
    };
  }
  return {
    title: "Hotkey listener stopped",
    description:
      "It was restarted twice and stopped again. Restart PrivateTranscribe to get your hotkey back.",
  };
}
