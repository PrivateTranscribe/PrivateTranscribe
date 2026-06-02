const { screen } = require("electron");
const {
  CONTAINER_W,
  CONTAINER_H,
  BUTTON_OFFSET_X,
  BUTTON_OFFSET_Y,
  WindowPositionUtil,
} = require("./windowConfig");

class DragManager {
  constructor() {
    this.isDragging = false;
    this.dragOffset = { x: 0, y: 0 };
    this.mouseTrackingInterval = null;
    this.targetWindow = null;
    this._positionChangeCallback = null;
    this.snapToTaskbar = false;
    this.lastCursorPosition = null;
    this.dragDisplay = null;
  }

  setTargetWindow(window) {
    this.targetWindow = window;
  }

  setPositionChangeCallback(callback) {
    this._positionChangeCallback = typeof callback === "function" ? callback : null;
  }

  setTaskbarSnapEnabled(enabled) {
    this.snapToTaskbar = enabled === true;
  }

  async startWindowDrag() {
    if (!this.targetWindow || this.targetWindow.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }

    if (this.isDragging) {
      return { success: true, message: "Drag already active" };
    }

    try {
      this.isDragging = true;

      // Get current cursor position
      const cursorPos = screen.getCursorScreenPoint();
      const windowPos = this.targetWindow.getPosition();
      this.lastCursorPosition = null;
      this.dragDisplay = screen.getDisplayNearestPoint({
        x: windowPos[0] + BUTTON_OFFSET_X,
        y: windowPos[1] + BUTTON_OFFSET_Y,
      });

      // Calculate offset from cursor to window position
      this.dragOffset = {
        x: cursorPos.x - windowPos[0],
        y: cursorPos.y - windowPos[1],
      };

      // Start tracking mouse movements
      this.setupMouseTracking();

      console.log("🖱️ Window drag started");
      return { success: true };
    } catch (error) {
      console.error("Failed to start window drag:", error);
      this.isDragging = false;
      return { success: false, message: error.message };
    }
  }

  async stopWindowDrag() {
    try {
      if (!this.isDragging) {
        this.lastCursorPosition = null;
        this.dragDisplay = null;
        this.stopMouseTracking();
        return { success: true, message: "Drag already stopped" };
      }

      this.isDragging = false;
      this.lastCursorPosition = null;
      this.dragDisplay = null;
      this.stopMouseTracking();
      console.log("🖱️ Window drag stopped");
      return { success: true };
    } catch (error) {
      console.error("Failed to stop window drag:", error);
      return { success: false, message: error.message };
    }
  }

  setupMouseTracking() {
    if (this.mouseTrackingInterval) {
      clearInterval(this.mouseTrackingInterval);
    }

    this.mouseTrackingInterval = setInterval(() => {
      if (this.isDragging && this.targetWindow && !this.targetWindow.isDestroyed()) {
        this.updateWindowPosition();
      }
    }, 16); // ~60fps
  }

  updateWindowPosition() {
    try {
      const cursorPos = screen.getCursorScreenPoint();

      // The overlay is moved from a native polling loop, not from DOM drag events.
      // Some Windows precision touchpads keep the loop alive with a stationary
      // cursor while the transparent BrowserWindow is being re-positioned under it;
      // repeatedly applying the same cursor sample can look like the button slowly
      // walks downward. Force the first sample after drag start, then ignore
      // duplicate cursor positions.
      if (
        this.lastCursorPosition &&
        cursorPos.x === this.lastCursorPosition.x &&
        cursorPos.y === this.lastCursorPosition.y
      ) {
        return;
      }
      this.lastCursorPosition = { x: cursorPos.x, y: cursorPos.y };

      const newX = cursorPos.x - this.dragOffset.x;
      const newY = cursorPos.y - this.dragOffset.y;

      // Clamp against the display nearest to the proposed button position, not
      // the raw cursor. Touchpads can fling the cursor into the taskbar or across
      // a monitor edge; the durable thing we care about is the overlay button
      // staying inside the active display work area.
      const proposedButtonPoint = {
        x: newX + BUTTON_OFFSET_X,
        y: newY + BUTTON_OFFSET_Y,
      };
      const display = this.snapToTaskbar
        ? this.dragDisplay || screen.getDisplayNearestPoint(proposedButtonPoint)
        : screen.getDisplayNearestPoint(proposedButtonPoint);
      const workArea = display.workArea || display.bounds;
      const constrained = this.snapToTaskbar
        ? WindowPositionUtil.getTaskbarSnappedPosition(
            newX,
            newY,
            CONTAINER_W,
            CONTAINER_H,
            display
          )
        : WindowPositionUtil.clampPosition(newX, newY, CONTAINER_W, CONTAINER_H, workArea);

      this.targetWindow.setPosition(constrained.x, constrained.y);

      // Note: BrowserWindow's `moved` event is not guaranteed to fire for programmatic
      // setPosition() on all platforms. Notify our consumer (WindowManager) so it can
      // persist the last known position reliably.
      if (this._positionChangeCallback) {
        this._positionChangeCallback(constrained.x, constrained.y);
      }
    } catch (error) {
      console.error("Error updating window position:", error);
      this.stopWindowDrag();
    }
  }

  stopMouseTracking() {
    if (this.mouseTrackingInterval) {
      clearInterval(this.mouseTrackingInterval);
      this.mouseTrackingInterval = null;
    }
  }

  isDragActive() {
    return this.isDragging;
  }

  getDragOffset() {
    return { ...this.dragOffset };
  }

  /**
   * Reset drag state without destroying the target window reference.
   * Safe to call after sleep/wake to clear any stuck isDragging=true state
   * that occurred if the system slept during an active drag.
   */
  resetDragState() {
    this.stopMouseTracking();
    this.isDragging = false;
    this.dragOffset = { x: 0, y: 0 };
    this.lastCursorPosition = null;
    this.dragDisplay = null;
  }

  cleanup() {
    this.stopWindowDrag();
    this.targetWindow = null;
  }
}

module.exports = DragManager;
