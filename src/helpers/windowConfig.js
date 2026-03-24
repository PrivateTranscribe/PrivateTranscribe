const path = require("path");

const WINDOW_SIZES = {
  BASE: { width: 96, height: 96 },
  CONSENT: { width: 420, height: 280 },
  WITH_MENU: { width: 300, height: 360 },
  // WITH_TOAST: narrower and shorter than before - the toast only needs ~180px of height
  // (toast ~70px + bottom button clearance ~90px + gap) and the width just needs to fit
  // the 320px toast with its 6px margin.  Keeping it tighter reduces the visual jolt when
  // the window expands near the right screen edge.
  WITH_TOAST: { width: 380, height: 180 },
  EXPANDED: { width: 400, height: 500 },
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
  width: WINDOW_SIZES.BASE.width,
  height: WINDOW_SIZES.BASE.height,
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
  skipTaskbar: false, // Keep visible in Dock/taskbar so app stays discoverable
  focusable: true,
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
  static getMainWindowPosition(display, customSize = null) {
    const { width, height } = customSize || WINDOW_SIZES.BASE;
    const workArea = display.workArea || display.bounds;
    // Default: bottom-center of the display workArea
    const x = Math.round(workArea.x + (workArea.width - width) / 2);
    const y = Math.round(workArea.y + workArea.height - height);
    return { x, y, width, height };
  }

  static clampPosition(x, y, width, height, workArea) {
    const cx = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width));
    const cy = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height));
    return { x: cx, y: cy };
  }

  static setupAlwaysOnTop(window) {
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
      window.setAlwaysOnTop(true, "pop-up-menu");
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
  WindowPositionUtil,
};
