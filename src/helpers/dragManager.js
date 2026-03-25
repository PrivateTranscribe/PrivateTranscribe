const { screen } = require("electron");
const { WINDOW_SIZES } = require("./windowConfig");

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

      // Get screen bounds to keep window visible
      const display = screen.getDisplayNearestPoint(cursorPos);
      const bounds = display.workArea;

      // Get window size for boundary calculations
      const windowBounds = this.targetWindow.getBounds();

      // Constrain so the visible button (not the transparent window frame) clamps to
      // screen edges.  For the BASE 160×160 window the button sits at left:24, bottom:24
      // (44×44px), so the transparent margins are asymmetric:
      //   Left/bottom margin: 24px  →  window can hang 24px off those edges
      //   Right/top margin:   92px  →  window can hang 92px off those edges
      // Non-BASE sizes (toast, menu) use symmetric clamping (no overhang).
      const isBase =
        windowBounds.width === WINDOW_SIZES.BASE.width &&
        windowBounds.height === WINDOW_SIZES.BASE.height;
      const mL = isBase ? 24 : 0;
      const mR = isBase ? WINDOW_SIZES.BASE.width - 24 - 44 : 0;
      const mT = isBase ? WINDOW_SIZES.BASE.height - 24 - 44 : 0;
      const mB = isBase ? 24 : 0;
      const constrainedX = Math.max(
        bounds.x - mL,
        Math.min(newX, bounds.x + bounds.width - windowBounds.width + mR)
      );
      const constrainedY = Math.max(
        bounds.y - mT,
        Math.min(newY, bounds.y + bounds.height - windowBounds.height + mB)
      );

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
