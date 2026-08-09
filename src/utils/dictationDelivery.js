/**
 * Commit a completed transcript to local history before attempting to
 * deliver it outside the app. A failed or unconfirmed paste always falls back
 * to the clipboard, even when the user's normal copy-after-paste preference is off.
 */
export async function deliverDictation({
  text,
  shouldPersist,
  shouldPaste,
  shouldCopy,
  additionalConfirmedDelivery = false,
  persist,
  paste,
  copy,
}) {
  let persisted = false;
  if (shouldPersist) {
    try {
      persisted = (await persist(text)) === true;
    } catch {
      persisted = false;
    }
  }

  let pasteConfirmed = null;
  if (shouldPaste) {
    try {
      pasteConfirmed = (await paste(text)) === true;
    } catch {
      pasteConfirmed = false;
    }
  }

  let copied = false;
  const needsClipboardFallback = shouldPaste && pasteConfirmed !== true;
  if (shouldCopy || needsClipboardFallback) {
    try {
      await copy(text);
      copied = true;
    } catch {
      copied = false;
    }
  }

  const outputAction = pasteConfirmed
    ? "paste"
    : copied
      ? needsClipboardFallback
        ? "copy-fallback"
        : "copy"
      : "none";

  const recoverable =
    persisted || pasteConfirmed === true || copied || additionalConfirmedDelivery === true;

  return { persisted, pasteConfirmed, copied, outputAction, recoverable };
}
