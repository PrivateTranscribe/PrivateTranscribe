/**
 * The Windows hotkey's tap and hold callbacks for ActivationGestureController,
 * turned into dictation messages for the overlay.
 *
 * Each hold gets a number that travels with its start-dictation and
 * cancel-dictation, so a cancel can only discard the recording its own start
 * began, never a hands-free dictation that was already running.
 *
 * With the overlay off, the window is created for each dictation, and a message
 * sent while it loads is lost. A hold's start arrives once the window is ready,
 * so its stop or cancel is sent again then. Cancellation is remembered per hold:
 * a newer hold that begins during the load must not hide that an older one was
 * cancelled, or the older hold's recording would run unseen until the next use
 * of the hotkey transcribed and pasted it.
 */
function createWindowsHoldDictation({ windowManager, logger }) {
  let holdStartActive = false;
  let holdToken = 0;
  // Holds cancelled before their start resolved. Each entry goes once its
  // start has resolved and the cancel has been sent again.
  const cancelledHolds = new Set();

  return {
    onTap: () => {
      logger.debug("[Activation] Tap completed");
      windowManager.sendToggleDictation();
    },
    onHoldStart: () => {
      logger.debug("[Activation] Hold threshold reached");
      holdStartActive = true;
      holdToken += 1;
      const thisHold = holdToken;
      Promise.resolve(windowManager.sendStartDictation(thisHold))
        .then(() => {
          // The key can be released while a hidden overlay is still loading.
          // Re-send cancel or stop after startup completes so a recording
          // cannot keep running and audio cannot stay ducked.
          if (cancelledHolds.delete(thisHold)) {
            windowManager.sendCancelDictation(thisHold);
          } else if (!holdStartActive) {
            windowManager.sendStopDictation();
          }
        })
        .catch((error) => {
          cancelledHolds.delete(thisHold);
          holdStartActive = false;
          windowManager.sendStopDictation();
          logger.warn("[Activation] Failed to start hold dictation", {
            error: error?.message || String(error),
          });
        });
    },
    onHoldEnd: () => {
      logger.debug("[Activation] Hold released");
      holdStartActive = false;
      windowManager.sendStopDictation();
    },
    // The listener found the hold was part of another shortcut or a mouse
    // action, so its recording is thrown away and nothing is pasted.
    onHoldCancel: () => {
      logger.debug("[Activation] Hold cancelled");
      holdStartActive = false;
      cancelledHolds.add(holdToken);
      windowManager.sendCancelDictation(holdToken);
    },
  };
}

module.exports = { createWindowsHoldDictation };
