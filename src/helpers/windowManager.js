const path = require("path");
const fs = require("fs");
const { app, screen, powerMonitor, BrowserWindow, dialog } = require("electron");
const HotkeyManager = require("./hotkeyManager");
const DragManager = require("./dragManager");
const MenuManager = require("./menuManager");
const DevServerManager = require("./devServerManager");
const debugLogger = require("./debugLogger");
const { DEV_SERVER_PORT } = DevServerManager;
const {
  MAIN_WINDOW_CONFIG,
  CONTROL_PANEL_CONFIG,
  CONTAINER_W,
  CONTAINER_H,
  BUTTON_OFFSET_X,
  BUTTON_OFFSET_Y,
  WindowPositionUtil,
} = require("./windowConfig");

class WindowManager {
  constructor() {
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this.tray = null;
    this.hotkeyManager = new HotkeyManager();
    this.dragManager = new DragManager();
    this.isQuitting = false;
    this.isMainWindowInteractive = false;
    this.loadErrorShown = false;
    this.windowsPushToTalkAvailable = false;
    this._windowsKeyManagerRef = null;
    this.activationModeCache = "tap";

    // Overlay stability: debounced re-apply always-on-top after blur/focus races.
    // Applies on Windows and Linux (incl. Unity desktop); macOS is exempt - the
    // "floating" panel level is managed reliably by the compositor there.
    this.mainWindowOnTopRepairTimer = null;

    // Position persistence
    this._positionFile = null;
    this._positionSaveTimer = null;
    this._pendingPosition = null;

    this._registerExitHandlers();

    app.on("before-quit", () => {
      this.isQuitting = true;
      this._flushPendingOverlayPosition("before-quit");
    });
  }

  _flushPendingOverlayPosition(reason) {
    // Cancel any scheduled debounce so it can't fire after we flush (and null _pendingPosition).
    if (this._positionSaveTimer) {
      clearTimeout(this._positionSaveTimer);
      this._positionSaveTimer = null;
    }

    if (!this._pendingPosition) return;

    try {
      fs.writeFileSync(this._getPositionFile(), JSON.stringify(this._pendingPosition), "utf8");
      debugLogger.info("[Window] Flushed overlay position:", {
        reason,
        position: this._pendingPosition,
      });
    } catch (err) {
      debugLogger.warn("[Window] Failed to flush overlay position:", {
        reason,
        error: err?.message || String(err),
      });
    }

    this._pendingPosition = null;
  }

  _registerExitHandlers() {
    // In dev, the app is often stopped via Ctrl+C, which triggers SIGINT/SIGTERM.
    // Ensure we flush the last known overlay position before exiting.
    const handle = (signal) => {
      try {
        this._flushPendingOverlayPosition(signal);
      } finally {
        // Ensure Electron gets a chance to shutdown cleanly.
        try {
          app.quit();
        } catch {
          // ignore
        }
      }
    };

    process.once("SIGINT", () => handle("SIGINT"));
    process.once("SIGTERM", () => handle("SIGTERM"));
  }

  setWindowsPushToTalkAvailable(available) {
    this.windowsPushToTalkAvailable = available;
  }

  setActivationMode(mode) {
    this.activationModeCache = mode === "push" ? "push" : "tap";
  }

  _getPositionFile() {
    if (!this._positionFile) {
      this._positionFile = path.join(app.getPath("userData"), "overlay-position.json");
      debugLogger.info("[Window] Overlay position file:", this._positionFile);
    }
    return this._positionFile;
  }

  _loadSavedPosition() {
    // Returns {x, y} as button screen center position, or null.
    try {
      const raw = fs.readFileSync(this._getPositionFile(), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.x === "number" && typeof parsed.y === "number") {
        if (parsed.v === 2) {
          // v2 format: x,y is the button's screen center position
          debugLogger.info("[Window] Loaded saved overlay position (v2):", parsed);
          return parsed;
        } else {
          // v1 format: x,y is the old 160×160 window top-left.
          // Button center was at (x+80, y+80) in the old BASE window.
          const migrated = { x: parsed.x + 80, y: parsed.y + 80, v: 2 };
          debugLogger.info("[Window] Migrated saved overlay position v1→v2:", {
            from: parsed,
            to: migrated,
          });
          return migrated;
        }
      }

      debugLogger.warn("[Window] Overlay position file invalid, resetting:", parsed);
      try {
        fs.unlinkSync(this._getPositionFile());
      } catch {
        // ignore
      }
    } catch (err) {
      debugLogger.info("[Window] No saved overlay position (yet):", err?.message || err);
      // No saved position or parse error - use default
    }
    return null;
  }

  _scheduleSavePosition(x, y) {
    // x,y is the button's screen center position (v2 format).
    this._pendingPosition = { x, y, v: 2 };

    if (this._positionSaveTimer) {
      clearTimeout(this._positionSaveTimer);
    }
    this._positionSaveTimer = setTimeout(() => {
      this._positionSaveTimer = null;
      const pos = this._pendingPosition;
      this._pendingPosition = null;

      // If we already flushed (or never had a valid position), don't write junk like `null`.
      if (!pos || typeof pos.x !== "number" || typeof pos.y !== "number") {
        return;
      }

      try {
        fs.writeFileSync(this._getPositionFile(), JSON.stringify(pos), "utf8");
      } catch (err) {
        debugLogger.debug("[Window] Failed to save overlay position:", err.message);
      }
    }, 500);
  }

  _reclampOverlayPosition(reason) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    const bounds = this.mainWindow.getBounds();
    const { width, height } = bounds;
    // Use button screen position for display detection (more accurate than window center).
    const display = screen.getDisplayNearestPoint({
      x: bounds.x + BUTTON_OFFSET_X,
      y: bounds.y + BUTTON_OFFSET_Y,
    });
    const workArea = display.workArea || display.bounds;
    const clamped = WindowPositionUtil.clampPosition(bounds.x, bounds.y, width, height, workArea);
    if (clamped.x !== bounds.x || clamped.y !== bounds.y) {
      debugLogger.info("[Window] Re-clamping overlay after", reason, {
        from: { x: bounds.x, y: bounds.y },
        to: clamped,
        workArea,
      });
      this.mainWindow.setBounds({ x: clamped.x, y: clamped.y, width, height });
      this._scheduleSavePosition(clamped.x + BUTTON_OFFSET_X, clamped.y + BUTTON_OFFSET_Y);
    } else {
      debugLogger.debug("[Window] Overlay already within bounds after", reason);
    }
  }

  async createMainWindow() {
    const display = screen.getPrimaryDisplay();

    const saved = this._loadSavedPosition();
    let position;
    if (saved) {
      // saved.x, saved.y is the button's screen center position (v2 format).
      // Clamp against the display that *contains* the saved button position, not always
      // the primary. Without this, an overlay saved on a secondary monitor gets snapped
      // to the primary display bounds on the next launch, causing it to jump across monitors.
      const btnX = saved.x;
      const btnY = saved.y;
      const winX = btnX - BUTTON_OFFSET_X;
      const winY = btnY - BUTTON_OFFSET_Y;
      const savedDisplay = screen.getDisplayNearestPoint({ x: btnX, y: btnY });
      const savedWorkArea = savedDisplay.workArea || savedDisplay.bounds;
      const clamped = WindowPositionUtil.clampPosition(
        winX,
        winY,
        CONTAINER_W,
        CONTAINER_H,
        savedWorkArea
      );
      position = { ...clamped, width: CONTAINER_W, height: CONTAINER_H };
    } else {
      position = WindowPositionUtil.getMainWindowPosition(display);
    }

    this.mainWindow = new BrowserWindow({
      ...MAIN_WINDOW_CONFIG,
      ...position,
    });

    // Main window (dictation overlay) should never appear in dock/taskbar
    // On macOS, users access the app via the menu bar tray icon
    // On Windows/Linux, the control panel stays in the taskbar when minimized
    this.mainWindow.setSkipTaskbar(true);

    this.setMainWindowInteractivity(false);
    this.registerMainWindowEvents();

    // Register load event handlers BEFORE loading to catch all events
    this.mainWindow.webContents.on(
      "did-fail-load",
      async (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        if (
          process.env.NODE_ENV === "development" &&
          validatedURL &&
          validatedURL.includes(`localhost:${DEV_SERVER_PORT}`)
        ) {
          // Retry connection to dev server
          setTimeout(async () => {
            const isReady = await DevServerManager.waitForDevServer();
            if (isReady) {
              this.mainWindow.reload();
            }
          }, 2000);
        } else {
          this.showLoadFailureDialog("Dictation panel", errorCode, errorDescription, validatedURL);
        }
      }
    );

    this.mainWindow.webContents.on("did-finish-load", () => {
      this.mainWindow.setTitle("Voice Recorder");
      this.enforceMainWindowOnTop();
    });

    // Now load the window content
    await this.loadMainWindow();
    await this.initializeHotkey();
    this.dragManager.setTargetWindow(this.mainWindow);
    this.dragManager.setPositionChangeCallback((winX, winY) => {
      this._scheduleSavePosition(winX + BUTTON_OFFSET_X, winY + BUTTON_OFFSET_Y);
    });
    MenuManager.setupMainMenu();

    // Re-clamp the overlay after sleep/wake so it doesn't drift when the workArea
    // changes (e.g. taskbar reappears at a different height, DPI scaling adjusts).
    // Delay slightly to let the OS finish restoring display configuration.
    powerMonitor.on("resume", () => {
      setTimeout(() => this._reclampOverlayPosition("resume"), 1000);
    });

    // Re-clamp whenever the display resolution, scale, or work area changes.
    screen.on("display-metrics-changed", () => {
      this._reclampOverlayPosition("display-metrics-changed");
    });
  }

  setMainWindowInteractivity(shouldCapture) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    if (shouldCapture) {
      this.mainWindow.setIgnoreMouseEvents(false);
    } else {
      this.mainWindow.setIgnoreMouseEvents(true, { forward: true });
    }
    this.isMainWindowInteractive = shouldCapture;
  }

  resizeMainWindow(_sizeKey) {
    // No-op: the overlay uses a fixed CONTAINER_W × CONTAINER_H transparent window.
    // Menu, toast, and recording state expand/collapse inside with CSS — Electron never
    // calls setBounds for these transitions, eliminating the button-jump on resize.
    return { success: true };
  }

  /**
   * Load content into a BrowserWindow, handling both dev server and production file loading.
   * @param {BrowserWindow} window - The window to load content into
   * @param {boolean} isControlPanel - Whether this is the control panel
   */
  async loadWindowContent(window, isControlPanel = false) {
    if (process.env.NODE_ENV === "development") {
      const appUrl = DevServerManager.getAppUrl(isControlPanel);
      await DevServerManager.waitForDevServer();
      await window.loadURL(appUrl);
    } else {
      // Production: use loadFile() for better compatibility with Electron 36+
      const fileInfo = DevServerManager.getAppFilePath(isControlPanel);
      if (!fileInfo) {
        throw new Error("Failed to get app file path");
      }

      const fs = require("fs");
      if (!fs.existsSync(fileInfo.path)) {
        throw new Error(`HTML file not found: ${fileInfo.path}`);
      }

      await window.loadFile(fileInfo.path, { query: fileInfo.query });
    }
  }

  async loadMainWindow() {
    await this.loadWindowContent(this.mainWindow, false);
  }

  createHotkeyCallback() {
    let lastToggleTime = 0;
    const DEBOUNCE_MS = 150;

    return async () => {
      if (this.hotkeyManager.isInListeningMode()) {
        return;
      }

      // Windows push mode: always defer to windowsKeyManager and never fall back to toggle
      // while activation mode is "push", even if listener is restarting.
      // Also check if windowsKeyManager is actively running - this is a synchronous
      // signal that prevents race conditions during startup before cache is populated.
      if (process.platform === "win32") {
        if (this.activationModeCache === "push") {
          return;
        }

        // If windowsKeyManager is actively listening, we're in push mode
        // even if the cache hasn't been updated yet (startup race)
        if (this._windowsKeyManagerRef?.isReady) {
          return;
        }

        const activationMode = await this.getActivationMode();
        if (activationMode === "push") {
          return;
        }
      }

      const now = Date.now();
      if (now - lastToggleTime < DEBOUNCE_MS) {
        return;
      }
      lastToggleTime = now;

      if (!this.mainWindow.isVisible()) {
        // Use showInactive to avoid stealing focus from the target app
        if (typeof this.mainWindow.showInactive === "function") {
          this.mainWindow.showInactive();
        } else {
          this.mainWindow.show();
        }
      }
      this.mainWindow.webContents.send("toggle-dictation");
    };
  }

  sendStartDictation() {
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      if (!this.mainWindow.isVisible()) {
        // Use showInactive to avoid stealing focus from the target app
        if (typeof this.mainWindow.showInactive === "function") {
          this.mainWindow.showInactive();
        } else {
          this.mainWindow.show();
        }
      }
      this.mainWindow.webContents.send("start-dictation");
    }
  }

  sendStopDictation() {
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("stop-dictation");
    }
  }

  async getActivationMode() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return this.activationModeCache;
    }
    try {
      const mode = await this.mainWindow.webContents.executeJavaScript(
        `localStorage.getItem("activationMode") || "tap"`
      );
      this.setActivationMode(mode);
      return this.activationModeCache;
    } catch {
      return this.activationModeCache;
    }
  }

  setHotkeyListeningMode(enabled) {
    this.hotkeyManager.setListeningMode(enabled);
  }

  async initializeHotkey() {
    await this.hotkeyManager.initializeHotkey(this.mainWindow, this.createHotkeyCallback());
  }

  async updateHotkey(hotkey) {
    return await this.hotkeyManager.updateHotkey(hotkey, this.createHotkeyCallback());
  }

  isUsingGnomeHotkeys() {
    return this.hotkeyManager.isUsingGnome();
  }

  async startWindowDrag() {
    return await this.dragManager.startWindowDrag();
  }

  async stopWindowDrag() {
    const result = await this.dragManager.stopWindowDrag();

    // Flush immediately - don't wait for the debounce - so the position is persisted even if
    // the app is force-quit/crashes shortly after the user releases the drag.
    this._flushPendingOverlayPosition("stopWindowDrag");

    return result;
  }

  async createControlPanelWindow() {
    if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
      if (this.controlPanelWindow.isMinimized()) {
        this.controlPanelWindow.restore();
      }
      if (!this.controlPanelWindow.isVisible()) {
        this.controlPanelWindow.show();
      }
      this.controlPanelWindow.focus();
      return;
    }

    this.controlPanelWindow = new BrowserWindow(CONTROL_PANEL_CONFIG);

    const visibilityTimer = setTimeout(() => {
      if (!this.controlPanelWindow || this.controlPanelWindow.isDestroyed()) {
        return;
      }
      if (!this.controlPanelWindow.isVisible()) {
        console.warn("Control panel did not become visible in time; forcing show");
        this.controlPanelWindow.show();
        this.controlPanelWindow.focus();
      }
    }, 10000);

    const clearVisibilityTimer = () => {
      clearTimeout(visibilityTimer);
    };

    this.controlPanelWindow.once("ready-to-show", () => {
      clearVisibilityTimer();
      // Show dock icon on macOS when control panel opens
      if (process.platform === "darwin" && app.dock) {
        app.dock.show();
      }
      this.controlPanelWindow.show();
      this.controlPanelWindow.focus();
    });

    this.controlPanelWindow.on("close", (event) => {
      if (!this.isQuitting) {
        event.preventDefault();
        this.hideControlPanelToTray();
      }
    });

    this.controlPanelWindow.on("closed", () => {
      clearVisibilityTimer();
      this.controlPanelWindow = null;
    });

    // Set up menu for control panel to ensure text input works
    MenuManager.setupControlPanelMenu(this.controlPanelWindow);

    this.controlPanelWindow.webContents.on("did-finish-load", () => {
      clearVisibilityTimer();
      this.controlPanelWindow.setTitle("PrivateTranscribe");
    });

    this.controlPanelWindow.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        clearVisibilityTimer();
        console.error("Failed to load control panel:", errorCode, errorDescription, validatedURL);
        if (process.env.NODE_ENV !== "development") {
          this.showLoadFailureDialog("Control panel", errorCode, errorDescription, validatedURL);
        }
        if (!this.controlPanelWindow.isVisible()) {
          this.controlPanelWindow.show();
          this.controlPanelWindow.focus();
        }
      }
    );

    await this.loadControlPanel();
  }

  async loadControlPanel() {
    await this.loadWindowContent(this.controlPanelWindow, true);
  }

  showDictationPanel(options = {}) {
    const { focus = false } = options;
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      if (!this.mainWindow.isVisible()) {
        if (typeof this.mainWindow.showInactive === "function") {
          this.mainWindow.showInactive();
        } else {
          this.mainWindow.show();
        }
      }
      if (focus) {
        this.mainWindow.focus();
      }
    }
  }

  hideControlPanelToTray() {
    if (!this.controlPanelWindow || this.controlPanelWindow.isDestroyed()) {
      return;
    }

    this.controlPanelWindow.hide();

    // Hide dock icon on macOS when control panel is hidden
    if (process.platform === "darwin" && app.dock) {
      app.dock.hide();
    }
  }

  hideDictationPanel() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      if (process.platform === "darwin") {
        this.mainWindow.hide();
      } else {
        this.mainWindow.minimize();
      }
    }
  }

  isDictationPanelVisible() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return false;
    }

    if (this.mainWindow.isMinimized && this.mainWindow.isMinimized()) {
      return false;
    }

    return this.mainWindow.isVisible();
  }

  registerMainWindowEvents() {
    if (!this.mainWindow) {
      return;
    }

    // Safety timeout: force show the window if ready-to-show doesn't fire within 10 seconds
    const showTimeout = setTimeout(() => {
      if (this.mainWindow && !this.mainWindow.isDestroyed() && !this.mainWindow.isVisible()) {
        this.mainWindow.show();
      }
    }, 10000);

    this.mainWindow.once("ready-to-show", () => {
      clearTimeout(showTimeout);
      this.enforceMainWindowOnTop();
      if (!this.mainWindow.isVisible()) {
        if (typeof this.mainWindow.showInactive === "function") {
          this.mainWindow.showInactive();
        } else {
          this.mainWindow.show();
        }
      }
    });

    this.mainWindow.on("show", () => {
      this.enforceMainWindowOnTop();
    });

    this.mainWindow.on("focus", () => {
      debugLogger.debug("[Window] main focus");
      this.enforceMainWindowOnTop();
    });

    this.mainWindow.on("blur", () => {
      // Windows and Linux (including Unity desktop with Compiz/Mutter) can lose
      // always-on-top when focus shifts to another window.  Re-apply after a short
      // delay to avoid blur/focus event races.
      // macOS is exempt: the "floating" panel level is maintained by the compositor.
      if (process.platform === "linux") {
        const desktop = process.env.XDG_CURRENT_DESKTOP || "unknown";
        const session = process.env.XDG_SESSION_TYPE || "unknown";
        debugLogger.debug(`[Window] main blur (linux desktop=${desktop} session=${session})`);
      } else {
        debugLogger.debug("[Window] main blur");
      }

      if (process.platform === "darwin") return;

      if (this.mainWindowOnTopRepairTimer) {
        clearTimeout(this.mainWindowOnTopRepairTimer);
      }

      this.mainWindowOnTopRepairTimer = setTimeout(() => {
        this.mainWindowOnTopRepairTimer = null;
        this.enforceMainWindowOnTop();
      }, 100);
    });

    this.mainWindow.on("minimize", () => {
      debugLogger.debug("[Window] main minimize");
    });

    this.mainWindow.on("restore", () => {
      debugLogger.debug("[Window] main restore");
      this.enforceMainWindowOnTop();
    });

    this.mainWindow.on("hide", () => {
      debugLogger.debug("[Window] main hide");
    });

    this.mainWindow.on("moved", () => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        const [x, y] = this.mainWindow.getPosition();
        this._scheduleSavePosition(x + BUTTON_OFFSET_X, y + BUTTON_OFFSET_Y);
      }
    });

    this.mainWindow.on("closed", () => {
      if (this.mainWindowOnTopRepairTimer) {
        clearTimeout(this.mainWindowOnTopRepairTimer);
        this.mainWindowOnTopRepairTimer = null;
      }
      if (this._positionSaveTimer) {
        clearTimeout(this._positionSaveTimer);
        this._positionSaveTimer = null;

        // If we were mid-debounce when the app is closed, flush the last seen position immediately.
        this._flushPendingOverlayPosition("closed");
      }
      this.dragManager.cleanup();
      this.mainWindow = null;
      this.isMainWindowInteractive = false;
    });
  }

  enforceMainWindowOnTop() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      WindowPositionUtil.setupAlwaysOnTop(this.mainWindow);
    }
  }

  showLoadFailureDialog(windowName, errorCode, errorDescription, validatedURL) {
    if (this.loadErrorShown) {
      return;
    }
    this.loadErrorShown = true;
    const detailLines = [
      `Window: ${windowName}`,
      `Error ${errorCode}: ${errorDescription}`,
      validatedURL ? `URL: ${validatedURL}` : null,
      "Try reinstalling the app or launching with --log-level=debug.",
    ].filter(Boolean);
    dialog.showMessageBox({
      type: "error",
      title: "PrivateTranscribe failed to load",
      message: "PrivateTranscribe could not load its UI.",
      detail: detailLines.join("\n"),
    });
  }
}

module.exports = WindowManager;
