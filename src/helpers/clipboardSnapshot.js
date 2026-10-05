/**
 * Preserve the common clipboard formats Electron can write together. Clipboard
 * contents stay in memory and must never be logged. Native formats such as
 * copied files and application-specific data are outside this snapshot.
 *
 * Accept the clipboard API explicitly so paste and selection capture share the
 * same behavior without depending on each other's managers or worker processes.
 */
function snapshotClipboard(clipboard) {
  const text = clipboard.readText();
  const html = clipboard.readHTML();
  const rtf = clipboard.readRTF();
  const image = clipboard.readImage();

  return {
    text,
    html,
    rtf,
    hasImage: image && typeof image.isEmpty === "function" ? !image.isEmpty() : false,
    image,
  };
}

/**
 * Electron ignores `clipboard.write({})`, so restoring an empty snapshot leaves
 * whatever was written since. Pass `clearWhenEmpty` when that would leak our
 * own data, such as Read Aloud's sentinel.
 */
function restoreClipboard(clipboard, snapshot, { clearWhenEmpty = false } = {}) {
  if (!snapshot) return;

  // One write restores all formats together; sequential writeText/writeHTML
  // calls would replace earlier formats.
  const payload = {};
  if (typeof snapshot.text === "string" && snapshot.text.length > 0) payload.text = snapshot.text;
  if (typeof snapshot.html === "string" && snapshot.html.length > 0) payload.html = snapshot.html;
  if (typeof snapshot.rtf === "string" && snapshot.rtf.length > 0) payload.rtf = snapshot.rtf;
  if (snapshot.hasImage && snapshot.image) payload.image = snapshot.image;

  try {
    if (Object.keys(payload).length > 0) clipboard.write(payload);
    else if (clearWhenEmpty) clipboard.clear();
  } catch {
    // Keep paste's existing best-effort text fallback. Restoration must not
    // mask the original capture error if the clipboard remains unavailable.
    try {
      clipboard.writeText(snapshot.text || "");
    } catch {
      // The OS refused both restoration attempts.
    }
  }
}

module.exports = { snapshotClipboard, restoreClipboard };
