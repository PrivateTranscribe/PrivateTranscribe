const { screen } = require("electron");
const { BUTTON_OFFSET_X, BUTTON_OFFSET_Y } = require("./windowConfig");

class DragManager {
  constructor() {
    this.isDragging = false;
    this.dragOffset = { x: 0, y: 0 };
    this.mouseTrackingInterval = null;
    this.targetWindow = null;
    this._positionChangeCallback = null;
  }

  setTargetWindow(window) {
    this.targetWindow = window;
  }

  setPositionChangeCallback(callback) {
    this._positionChangeCallback = typeof callback === "function" ? callback : null;
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

      // Get screen bounds to keep the button within the work area.
      const display = screen.getDisplayNearestPoint(cursorPos);
      const bounds = display.workArea;

      // Constrain so the button center (at BUTTON_OFFSET_X, BUTTON_OFFSET_Y within the
      // fixed 400×500 container) stays within the work area.
      const btnX = newX + BUTTON_OFFSET_X;
      const btnY = newY + BUTTON_OFFSET_Y;
      const clampedBtnX = Math.max(bounds.x, Math.min(btnX, bounds.x + bounds.width));
      const clampedBtnY = Math.max(bounds.y, Math.min(btnY, bounds.y + bounds.height));
      const constrainedX = clampedBtnX - BUTTON_OFFSET_X;
      const constrainedY = clampedBtnY - BUTTON_OFFSET_Y;

      this.targetWindow.setPosition(constrainedX, constrainedY);

      // Note: BrowserWindow's `moved` event is not guaranteed to fire for programmatic
      // setPosition() on all platforms. Notify our consumer (WindowManager) so it can
      // persist the last known position reliably.
      if (this._positionChangeCallback) {
        this._positionChangeCallback(constrainedX, constrainedY);
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
