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
    this.snapToTaskbar = true;
  }

  setTargetWindow(window) {
    this.targetWindow = window;
  }

  setPositionChangeCallback(callback) {
    this._positionChangeCallback = typeof callback === "function" ? callback : null;
  }

  setTaskbarSnapEnabled(enabled) {
    this.snapToTaskbar = enabled !== false;
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
        this.stopMouseTracking();
        return { success: true, message: "Drag already stopped" };
      }

      this.isDragging = false;
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
      const display = screen.getDisplayNearestPoint(proposedButtonPoint);
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

  cleanup() {
    this.stopWindowDrag();
    this.targetWindow = null;
  }
}

module.exports = DragManager;
