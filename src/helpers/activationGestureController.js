const DEFAULT_HOLD_THRESHOLD_MS = 150;

function normalizeMode(mode) {
  if (mode === "push" || mode === "tapHold") {
    return mode;
  }
  return "tap";
}

/**
 * Converts key-down/key-up events into mutually exclusive tap and hold gestures.
 * Repeated key-down events from keyboard auto-repeat are ignored until key-up.
 */
class ActivationGestureController {
  constructor({
    mode = "tap",
    holdThresholdMs = DEFAULT_HOLD_THRESHOLD_MS,
    onTap = () => {},
    onHoldStart = () => {},
    onHoldEnd = () => {},
    // A hold that discard() throws away. Without one, the hold just ends.
    onHoldCancel = onHoldEnd,
  } = {}) {
    this.mode = normalizeMode(mode);
    this.holdThresholdMs = holdThresholdMs;
    this.onTap = onTap;
    this.onHoldStart = onHoldStart;
    this.onHoldEnd = onHoldEnd;
    this.onHoldCancel = onHoldCancel;
    this.isPressed = false;
    this.holdTriggered = false;
    this.pressExpired = false;
    this.holdTimer = null;
  }

  setMode(mode) {
    const nextMode = normalizeMode(mode);
    if (nextMode === this.mode) {
      return;
    }

    this.cancel();
    this.mode = nextMode;
  }

  keyDown() {
    if (this.isPressed) {
      return false;
    }

    this.isPressed = true;
    this.holdTriggered = false;
    this.pressExpired = false;
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (!this.isPressed) {
        return;
      }

      // Crossing the threshold consumes tap mode without firing anything.
      // Hold and Both modes begin their hold gesture at the threshold.
      if (this.mode === "push" || this.mode === "tapHold") {
        this.holdTriggered = true;
        this.onHoldStart();
      } else {
        this.pressExpired = true;
      }
    }, this.holdThresholdMs);

    return true;
  }

  keyUp() {
    if (!this.isPressed) {
      return false;
    }

    this.isPressed = false;
    this.clearHoldTimer();

    if (this.holdTriggered) {
      this.holdTriggered = false;
      this.pressExpired = false;
      this.onHoldEnd();
      return true;
    }

    if (!this.pressExpired && (this.mode === "tap" || this.mode === "tapHold")) {
      this.onTap();
    }
    this.pressExpired = false;

    return true;
  }

  /**
   * Drops a press that turned out to be part of another shortcut or a mouse
   * action, so its key-up fires nothing. A hold that already started goes to
   * onHoldCancel, which throws its recording away instead of transcribing it.
   */
  discard() {
    if (!this.isPressed) {
      return false;
    }

    const holdStarted = this.holdTriggered;
    this.isPressed = false;
    this.holdTriggered = false;
    this.pressExpired = false;
    this.clearHoldTimer();

    if (holdStarted) {
      this.onHoldCancel();
    }
    return true;
  }

  cancel() {
    const shouldEndHold = this.holdTriggered;
    this.isPressed = false;
    this.holdTriggered = false;
    this.pressExpired = false;
    this.clearHoldTimer();

    if (shouldEndHold) {
      this.onHoldEnd();
    }
  }

  clearHoldTimer() {
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }
}

module.exports = ActivationGestureController;
module.exports.DEFAULT_HOLD_THRESHOLD_MS = DEFAULT_HOLD_THRESHOLD_MS;
