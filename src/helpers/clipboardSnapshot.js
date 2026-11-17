/**
 * Save the user's clipboard before we write to it, and put it back afterwards.
 * Clipboard contents stay in memory and must never be logged.
 *
 * Electron 44 replaced the synchronous per-format readers with the W3C-style
 * `clipboard.read()`, which lists every format the OS clipboard holds by MIME
 * type. The snapshot keeps the standard types: text, HTML, RTF, images, and
 * copied files, which Windows exposes as `text/uri-list`. It skips the raw
 * platform formats (`electron application/osclipboard;format=...`), such as
 * Excel's native cell data. Reading a format makes its owner render it, and a
 * large raw format would delay every dictation. Pasting after a restore
 * therefore works from the standard formats, as it did before Electron 44.
 *
 * Accept the clipboard API explicitly so paste and selection capture share the
 * same behavior without depending on each other's managers or worker processes.
 */
const SNAPSHOT_TYPES = ["text/plain", "text/html", "text/rtf", "image/png", "text/uri-list"];

async function snapshotClipboard(clipboard) {
  const formats = {};
  for (const item of await clipboard.read()) {
    for (const type of item.types) {
      if (!SNAPSHOT_TYPES.includes(type) || Object.hasOwn(formats, type)) continue;
      formats[type] = await item.getType(type);
    }
  }
  const text = formats["text/plain"] ? await formats["text/plain"].text() : "";
  return { text, formats };
}

/**
 * Restoring an empty snapshot writes nothing, so whatever was written since
 * would stay. Pass `clearWhenEmpty` when that would leak our own data, such as
 * Read Aloud's sentinel. Never rejects: restoration is best effort and must not
 * mask the error of the operation it cleans up after.
 */
async function restoreClipboard(
  clipboard,
  ClipboardItem,
  snapshot,
  { clearWhenEmpty = false } = {}
) {
  if (!snapshot) return;

  try {
    // One write restores all formats together; a second write would replace
    // the first.
    if (Object.keys(snapshot.formats || {}).length > 0) {
      await clipboard.write([new ClipboardItem(snapshot.formats)]);
    } else if (clearWhenEmpty) {
      clipboard.clear();
    }
  } catch {
    // Keep paste's existing best-effort text fallback.
    try {
      await clipboard.writeText(snapshot.text || "");
    } catch {
      // The OS refused both restoration attempts.
    }
  }
}

module.exports = { snapshotClipboard, restoreClipboard };
