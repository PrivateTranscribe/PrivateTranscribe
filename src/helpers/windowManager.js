const path = require("path");
const fs = require("fs");
const { app, screen, BrowserWindow, dialog } = require("electron");
const HotkeyManager = require("./hotkeyManager");
const DragManager = require("./dragManager");
const MenuManager = require("./menuManager");
const DevServerManager = require("./devServerManager");
const debugLogger = require("./debugLogger");
const { DEV_SERVER_PORT } = DevServerManager;
const {
  MAIN_WINDOW_CONFIG,
  CONTROL_PANEL_CONFIG,
  WINDOW_SIZES,
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

    // Windows overlay stability: debounced re-apply always-on-top after blur/focus races.
    this.mainWindowOnTopRepairTimer = null;

    // Position persistence
    this._positionFile = null;
    this._positionSaveTimer = null;

    app.on("before-quit", () => {
      this.isQuitting = true;
    });
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
    }
    return this._positionFile;
  }

  _loadSavedPosition() {
    try {
      const raw = fs.readFileSync(this._getPositionFile(), "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed.x === "number" && typeof parsed.y === "number") {
        return parsed;
      }
    } catch {
      // No saved position or parse error — use default
    }
    return null;
  }

  _scheduleSavePosition(x, y) {
    if (this._positionSaveTimer) {
      clearTimeout(this._positionSaveTimer);
    }
    this._positionSaveTimer = setTimeout(() => {
      this._positionSaveTimer = null;
      try {
        fs.writeFileSync(this._getPositionFile(), JSON.stringify({ x, y }), "utf8");
      } catch (err) {
        debugLogger.debug("[Window] Failed to save overlay position:", err.message);
      }
    }, 500);
  }

  async createMainWindow() {
    const display = screen.getPrimaryDisplay();
    const { width, height } = WINDOW_SIZES.BASE;
    const workArea = display.workArea || display.bounds;

    const saved = this._loadSavedPosition();
    let position;
    if (saved) {
      const clamped = WindowPositionUtil.clampPosition(saved.x, saved.y, width, height, workArea);
      position = { ...clamped, width, height };
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
    MenuManager.setupMainMenu();
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

  resizeMainWindow(sizeKey) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }

    const newSize = WINDOW_SIZES[sizeKey] || WINDOW_SIZES.BASE;
    const currentBounds = this.mainWindow.getBounds();

    // Anchor at bottom-left corner when resizing
    const bottomLeftX = currentBounds.x;
    const bottomLeftY = currentBounds.y + currentBounds.height;

    const display = screen.getDisplayNearestPoint({ x: bottomLeftX, y: bottomLeftY });
    const workArea = display.workArea || display.bounds;

    // Keep same X (left edge), adjust Y to maintain bottom alignment
    let newX = bottomLeftX;
    let newY = bottomLeftY - newSize.height;

    // Clamp within viewport bounds (prevent off-screen drift)
    newX = Math.max(workArea.x, Math.min(newX, workArea.x + workArea.width - newSize.width));
    newY = Math.max(workArea.y, Math.min(newY, workArea.y + workArea.height - newSize.height));

    this.mainWindow.setBounds({
      x: newX,
      y: newY,
      width: newSize.width,
      height: newSize.height,
    });

    return { success: true, bounds: { x: newX, y: newY, ...newSize } };
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
      // Also check if windowsKeyManager is actively running — this is a synchronous
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
    return await this.dragManager.stopWindowDrag();
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
      this.controlPanelWindow.setTitle("Privoca");
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
      // Windows can lose always-on-top when focus shifts; re-apply after a short delay
      // to avoid blur/focus event races.
      debugLogger.debug("[Window] main blur");
      if (process.platform !== "win32") return;

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
        this._scheduleSavePosition(x, y);
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
      title: "Privoca failed to load",
      message: "Privoca could not load its UI.",
      detail: detailLines.join("\n"),
    });
  }
}

module.exports = WindowManager;
