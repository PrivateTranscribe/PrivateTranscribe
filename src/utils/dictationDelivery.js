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
  // What the paste attempt could actually observe, when it can say. "none"
  // means the target was unreadable and neither success nor failure is known.
  let pasteEvidence = null;
  let pasteDispatched = false;
  let copied = false;
  if (shouldPaste) {
    try {
      const outcome = await paste(text);
      if (outcome && typeof outcome === "object") {
        pasteConfirmed = outcome.delivered === true;
        pasteEvidence = outcome.evidence ?? null;
        pasteDispatched = outcome.dispatched === true;
        copied = outcome.clipboardPreserved === true;
      } else {
        pasteConfirmed = outcome === true;
      }
    } catch {
      pasteConfirmed = false;
    }
  }

  const needsClipboardFallback = shouldPaste && pasteConfirmed !== true;
  // A native paste may have already left the transcript on the clipboard.
  // Rewriting it here races the target's asynchronous clipboard read.
  if (!copied && (shouldCopy || needsClipboardFallback)) {
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

  return {
    persisted,
    pasteConfirmed,
    pasteEvidence,
    pasteDispatched,
    copied,
    outputAction,
    recoverable,
  };
}
