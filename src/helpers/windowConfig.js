const path = require("path");

// Fixed transparent container — the overlay window is always this size.
// All UI (button, menu, toast) expands/collapses inside with CSS.
// Electron never calls setBounds for state changes, only for user drag repositioning.
const CONTAINER_W = 400;
const CONTAINER_H = 500;

// Button (44×44px) is positioned at bottom:58px, left:50% (transform translateX(-50%))
// within the container. These offsets describe the button's center from the container's
// top-left corner and are used to convert between window position and button screen position.
const BUTTON_OFFSET_X = CONTAINER_W / 2; // 200 — horizontal center of container
const BUTTON_OFFSET_Y = CONTAINER_H - 58 - 22; // 420 — 58px from bottom + half button height
const BUTTON_HALF = 22; // half of the 44px overlay button
const TASKBAR_SNAP_GAP = 8; // visible gap between the overlay button and taskbar/work-area edge
const TASKBAR_SNAP_OFFSET = BUTTON_HALF + TASKBAR_SNAP_GAP; // button-center distance from that edge

// Legacy size constants kept for reference only. The overlay no longer resizes
// between these states at runtime.
const WINDOW_SIZES = {
  BASE: { width: 160, height: 160 },
  WITH_MENU: { width: 300, height: 360 },
  WITH_TOAST: { width: 380, height: 180 },
  EXPANDED: { width: CONTAINER_W, height: CONTAINER_H },
};

// Helper to get icon path for Windows
function getWindowIcon() {
  if (process.platform !== "win32") {
    return undefined;
  }

  // In production, the icon is in resources/src/assets/
  // In development, it's in src/assets/
  const isDev = process.env.NODE_ENV === "development";

  if (isDev) {
    return path.join(__dirname, "..", "assets", "icon.ico");
  } else {
    // In production, resources are accessed via process.resourcesPath
    return path.join(process.resourcesPath, "src", "assets", "icon.ico");
  }
}

// Main dictation window configuration
const MAIN_WINDOW_CONFIG = {
  width: CONTAINER_W,
  height: CONTAINER_H,
  title: "Voice Recorder",
  icon: getWindowIcon(),
  webPreferences: {
    preload: path.join(__dirname, "..", "..", "preload.js"),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  },
  frame: false,
  alwaysOnTop: true,
  resizable: false,
  transparent: true,
  show: false, // Start hidden, show after setup
  // The dictation overlay is a passive control, not the main application surface.
  // Keeping it out of Alt-Tab/taskbar and non-focusable on Windows avoids stealing
  // focus from fullscreen games and reduces DWM/topmost-window churn while gaming.
  // The control panel remains the discoverable taskbar window.
  skipTaskbar: process.platform === "win32",
  focusable: true, // Must be true to allow clicking the mic button and dragging the overlay
  visibleOnAllWorkspaces: process.platform !== "win32",
  fullScreenable: false,
  hasShadow: false, // Remove shadow for cleaner look
  acceptsFirstMouse: true, // Accept clicks even when not focused
  type: process.platform === "darwin" ? "panel" : "normal", // Panel on macOS preserves floating behavior
};

// Control panel window configuration
const CONTROL_PANEL_CONFIG = {
  width: 1200,
  height: 800,
  minWidth: 1024,
  minHeight: 700,
  icon: getWindowIcon(),
  webPreferences: {
    preload: path.join(__dirname, "..", "..", "preload.js"),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    spellcheck: false,
  },
  title: "PrivateTranscribe",
  resizable: true,
  show: false,
  frame: false,
  ...(process.platform === "darwin" && {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 20 },
  }),
  transparent: false,
  minimizable: true,
  maximizable: true,
  closable: true,
  fullscreenable: true,
  skipTaskbar: false, // Ensure control panel stays in taskbar
  alwaysOnTop: false, // Control panel should not be always on top
  visibleOnAllWorkspaces: false, // Control panel should stay in its workspace
  type: "normal", // Ensure it's a normal window, not a panel
};

// Window positioning utilities
class WindowPositionUtil {
  static getMainWindowPosition(display) {
    const workArea = display.workArea || display.bounds;
    // Position the fixed CONTAINER_W×CONTAINER_H window so the button lands at
    // bottom-center of the work area (matching the old BASE-window default position).
    const x = Math.round(workArea.x + (workArea.width - CONTAINER_W) / 2);
    const y = Math.round(workArea.y + workArea.height - CONTAINER_H);
    return { x, y, width: CONTAINER_W, height: CONTAINER_H };
  }

  static getTaskbarEdge(display) {
    const bounds = display.bounds || {};
    const workArea = display.workArea || bounds;
    const insets = {
      left: Math.max(0, workArea.x - bounds.x),
      right: Math.max(0, bounds.x + bounds.width - (workArea.x + workArea.width)),
      top: Math.max(0, workArea.y - bounds.y),
      bottom: Math.max(0, bounds.y + bounds.height - (workArea.y + workArea.height)),
    };

    let edge = "bottom";
    let maxInset = 0;
    for (const [candidateEdge, inset] of Object.entries(insets)) {
      if (inset > maxInset) {
        maxInset = inset;
        edge = candidateEdge;
      }
    }

    // Auto-hidden taskbars can make workArea equal bounds. Bottom is the least surprising
    // fallback and matches the current Windows 11 default.
    return edge;
  }

  static getTaskbarInset(display, edge) {
    const bounds = display.bounds || {};
    const workArea = display.workArea || bounds;
    const insets = {
      left: Math.max(0, workArea.x - bounds.x),
      right: Math.max(0, bounds.x + bounds.width - (workArea.x + workArea.width)),
      top: Math.max(0, workArea.y - bounds.y),
      bottom: Math.max(0, bounds.y + bounds.height - (workArea.y + workArea.height)),
    };
    return insets[edge] || 0;
  }

  static clampButtonCenter(btnX, btnY, area) {
    const clampedBtnX = Math.max(
      area.x + BUTTON_HALF,
      Math.min(btnX, area.x + area.width - BUTTON_HALF)
    );
    const clampedBtnY = Math.max(
      area.y + BUTTON_HALF,
      Math.min(btnY, area.y + area.height - BUTTON_HALF)
    );
    return {
      x: Math.round(clampedBtnX - BUTTON_OFFSET_X),
      y: Math.round(clampedBtnY - BUTTON_OFFSET_Y),
    };
  }

  static getTaskbarSnappedPosition(x, y, width, height, display) {
    const bounds = display.bounds || {};
    const workArea = display.workArea || display.bounds;
    const edge = this.getTaskbarEdge(display);
    const taskbarInset = this.getTaskbarInset(display, edge);
    const proposedBtnX = x + BUTTON_OFFSET_X;
    const proposedBtnY = y + BUTTON_OFFSET_Y;

    let btnX = proposedBtnX;
    let btnY = proposedBtnY;

    // Auto-hidden taskbars can make workArea match bounds. In that case there is
    // no visible taskbar band to sit on, so keep the button just inside the screen.
    if (taskbarInset <= 0) {
      if (edge === "left" || edge === "right") {
        btnX =
          edge === "left"
            ? workArea.x + TASKBAR_SNAP_OFFSET
            : workArea.x + workArea.width - TASKBAR_SNAP_OFFSET;
      } else {
        btnY =
          edge === "top"
            ? workArea.y + TASKBAR_SNAP_OFFSET
            : workArea.y + workArea.height - TASKBAR_SNAP_OFFSET;
      }
      return this.clampPosition(
        Math.round(btnX - BUTTON_OFFSET_X),
        Math.round(btnY - BUTTON_OFFSET_Y),
        width,
        height,
        workArea
      );
    }

    if (edge === "left" || edge === "right") {
      const taskbarStart =
        edge === "left"
          ? bounds.x
          : workArea.x + workArea.width;
      btnX = taskbarStart + taskbarInset / 2;
      btnY = Math.max(
        workArea.y + BUTTON_HALF,
        Math.min(proposedBtnY, workArea.y + workArea.height - BUTTON_HALF)
      );
    } else {
      btnX = Math.max(
        workArea.x + BUTTON_HALF,
        Math.min(proposedBtnX, workArea.x + workArea.width - BUTTON_HALF)
      );
      const taskbarStart =
        edge === "top"
          ? bounds.y
          : workArea.y + workArea.height;
      btnY = taskbarStart + taskbarInset / 2;
    }

    return this.clampButtonCenter(btnX, btnY, bounds);
  }

  static clampPosition(x, y, width, height, workArea) {
    // Clamp so the full 44px button stays visible within the work area.
    // We clamp against the button *edge* (not just center) so the button can't hang off screen.
    // width/height are accepted for API compatibility but the window is always CONTAINER_W × CONTAINER_H.
    return this.clampButtonCenter(x + BUTTON_OFFSET_X, y + BUTTON_OFFSET_Y, workArea);
  }

  static setupAlwaysOnTop(window, options = {}) {
    const { aboveTaskbar = false } = options;

    if (process.platform === "darwin") {
      // macOS: Use panel level for proper floating behavior
      // This ensures the window stays on top across spaces and fullscreen apps
      window.setAlwaysOnTop(true, "floating", 1);
      window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true, // Keep Dock/Command-Tab behaviour
      });
      window.setFullScreenable(false);

      // Ensure window level is maintained
      if (window.isVisible()) {
        window.setAlwaysOnTop(true, "floating", 1);
      }
    } else if (process.platform === "win32") {
      // Electron documents pop-up-menu and higher as the levels that are shown
      // above the Windows taskbar. Use that only when the user explicitly opts
      // into snapping the overlay onto the taskbar band; otherwise keep the
      // passive overlay at "floating" to avoid compositor churn in fullscreen
      // games (reported with Minecraft/Tekkit).
      window.setAlwaysOnTop(true, aboveTaskbar ? "pop-up-menu" : "floating");
      if (aboveTaskbar && typeof window.moveTop === "function") {
        window.moveTop();
      }
    } else {
      // Linux - "screen-saver" is the highest named level Electron exposes for X11/Wayland.
      // On Unity desktop (Compiz/Mutter), this maps to _NET_WM_STATE_ABOVE which should
      // keep the overlay above normal application windows.  However the compositor is not
      // obliged to honour it when a fullscreen or override-redirect window takes focus
      // (e.g. a Unity game running at native resolution).  Known constraints:
      //   • X11/Unity: topmost is advisory - fullscreen windows or those with
      //     _NET_WM_STATE_FULLSCREEN may still occlude the overlay.
      //   • Wayland: no equivalent global always-on-top protocol; "screen-saver" is
      //     passed as a hint but compositor behaviour is undefined.
      //   • GNOME Shell (X11 or Wayland): generally respects the level.
      // Mitigation: a debounced re-apply is triggered on every blur event (windowManager.js).
      window.setAlwaysOnTop(true, "screen-saver");

      // Unconditionally push to front so the Z-order is refreshed even when the window
      // manager deferred the _NET_WM_STATE update to the next event-loop tick.
      window.moveTop();
    }

    // Bring window to front if visible (macOS / Windows path falls through here)
    if (window.isVisible() && process.platform !== "linux") {
      window.moveTop();
    }
  }

  static setupControlPanel(window) {
    // Control panel should behave like a normal application window
    // This is only called once during window creation
    // No need to repeatedly set these values
  }
}

module.exports = {
  MAIN_WINDOW_CONFIG,
  CONTROL_PANEL_CONFIG,
  WINDOW_SIZES,
  CONTAINER_W,
  CONTAINER_H,
  BUTTON_OFFSET_X,
  BUTTON_OFFSET_Y,
  BUTTON_HALF,
  TASKBAR_SNAP_GAP,
  TASKBAR_SNAP_OFFSET,
  WindowPositionUtil,
};
