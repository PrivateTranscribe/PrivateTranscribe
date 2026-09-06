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
  if (shouldPaste) {
    try {
      const outcome = await paste(text);
      if (outcome && typeof outcome === "object") {
        pasteConfirmed = outcome.delivered === true;
        pasteEvidence = outcome.evidence ?? null;
        pasteDispatched = outcome.dispatched === true;
      } else {
        pasteConfirmed = outcome === true;
      }
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
