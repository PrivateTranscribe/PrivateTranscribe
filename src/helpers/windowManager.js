const path = require("path");
const fs = require("fs");
const { app, screen, powerMonitor, BrowserWindow, dialog } = require("electron");
const HotkeyManager = require("./hotkeyManager");
const DragManager = require("./dragManager");
const MenuManager = require("./menuManager");
const DevServerManager = require("./devServerManager");
const debugLogger = require("./debugLogger");
const { DEV_SERVER_PORT } = DevServerManager;
const isEnvFlagEnabled = (name) => {
  const value = process.env[name];
  if (value === undefined || value === null) return false;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
};

const {
  MAIN_WINDOW_CONFIG,
  CONTROL_PANEL_CONFIG,
  CONTAINER_W,
  CONTAINER_H,
  BUTTON_OFFSET_X,
  BUTTON_OFFSET_Y,
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
    this.isMainWindowOverlaySuspended = false;
    this.mainWindowRendererReady = false;
    this._overlayStateChangeCallback = null;
    this.overlayDisabled = false;

    // Overlay stability: debounced re-apply always-on-top after blur/focus races.
    // Applies on Windows and Linux (incl. Unity desktop); macOS is exempt - the
    // "floating" panel level is managed reliably by the compositor there.
    this.mainWindowOnTopRepairTimer = null;

    // Position persistence
    this._positionFile = null;
    this._positionSaveTimer = null;
    this._pendingPosition = null;
    this._displayMetricsTimer = null;
    this._powerResumeHandler = null;
    this._displayMetricsChangedHandler = null;

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

  setOverlayStateChangeCallback(callback) {
    this._overlayStateChangeCallback = typeof callback === "function" ? callback : null;
  }

  _notifyOverlayStateChanged() {
    if (!this._overlayStateChangeCallback) {
      return;
    }

    try {
      this._overlayStateChangeCallback(this.mainWindow);
    } catch (error) {
      debugLogger.debug("[Window] Overlay state callback failed:", error?.message || String(error));
    }
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
        if (parsed.v === 3) {
          // v3 format: x,y is the button's screen center position (96×96 BASE window era)
          debugLogger.info("[Window] Loaded saved overlay position (v3):", parsed);
          return parsed;
        } else {
          // v1/v2: saved with old 400×500 window offsets — discard and use default position
          debugLogger.info("[Window] Discarding old overlay position (v" + (parsed.v || 1) + ") — window size changed");
          try { fs.unlinkSync(this._getPositionFile()); } catch { /* ignore */ }
          return null;
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

  _getButtonScreenPos() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return null;
    const b = this.mainWindow.getBounds();
    // Button is horizontally centered and 42px from the bottom of the current window
    return {
      x: b.x + Math.round(b.width / 2),
      y: b.y + b.height - 42,
    };
  }

  _scheduleSavePosition(x, y) {
    // x,y is the button's screen center position (v3 format).
    this._pendingPosition = { x, y, v: 3 };

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
    const btnPos = this._getButtonScreenPos();
    const display = screen.getDisplayNearestPoint(btnPos || {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height,
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
      const newBtn = this._getButtonScreenPos();
      if (newBtn) this._scheduleSavePosition(newBtn.x, newBtn.y);
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
      // Button is centered horizontally and ~42px from bottom in BASE window
      const baseW = WINDOW_SIZES.BASE.width;
      const baseH = WINDOW_SIZES.BASE.height;
      const winX = btnX - baseW / 2;
      const winY = btnY - (baseH - 42);
      const savedDisplay = screen.getDisplayNearestPoint({ x: btnX, y: btnY });
      const savedWorkArea = savedDisplay.workArea || savedDisplay.bounds;
      const clamped = WindowPositionUtil.clampPosition(
        winX,
        winY,
        WINDOW_SIZES.BASE.width,
        WINDOW_SIZES.BASE.height,
        savedWorkArea
      );
      position = { ...clamped, width: WINDOW_SIZES.BASE.width, height: WINDOW_SIZES.BASE.height };
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
    await this.waitForMainWindowRendererReady();
    this.dragManager.setTargetWindow(this.mainWindow);
    this.dragManager.setPositionChangeCallback((winX, winY) => {
      // Use current window width to compute button center (window may have been resized)
      const currentW = this.mainWindow?.isDestroyed() ? WINDOW_SIZES.BASE.width : (this.mainWindow?.getBounds().width ?? WINDOW_SIZES.BASE.width);
      const currentH = this.mainWindow?.isDestroyed() ? WINDOW_SIZES.BASE.height : (this.mainWindow?.getBounds().height ?? WINDOW_SIZES.BASE.height);
      this._scheduleSavePosition(winX + Math.round(currentW / 2), winY + currentH - 42);
    });
    MenuManager.setupMainMenu();

    // Re-clamp the overlay after sleep/wake so it doesn't drift when the workArea
    // changes (e.g. taskbar reappears at a different height, DPI scaling adjusts).
    // Delay slightly to let the OS finish restoring display configuration.
    this._powerResumeHandler = () => {
      setTimeout(() => this._reclampOverlayPosition("resume"), 1000);
    };
    powerMonitor.on("resume", this._powerResumeHandler);

    // Re-clamp whenever the display resolution, scale, or work area changes.
    // Debounce: this event fires many times during sleep/wake and screen on/off while
    // the work area is in flux (taskbar not yet registered, DPI not yet settled).
    // Firing immediately can save a wrong clamped position, which persists across reboots.
    // Wait 2 s after the last event so we act on the final stable work area.
    this._displayMetricsChangedHandler = () => {
      if (this._displayMetricsTimer) clearTimeout(this._displayMetricsTimer);
      this._displayMetricsTimer = setTimeout(() => {
        this._displayMetricsTimer = null;
        this._reclampOverlayPosition("display-metrics-changed");
      }, 2000);
    };
    screen.on("display-metrics-changed", this._displayMetricsChangedHandler);
  }

  setMainWindowInteractivity(shouldCapture) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    // On Windows, never use setIgnoreMouseEvents(true, { forward: true }).
    // That flag installs a WH_MOUSE_LL global low-level mouse hook which intercepts
    // ALL mouse input system-wide before forwarding it — causing mouse stutter in
    // windowed games (Minecraft/Tekkit) even when the game has mouse capture.
    // OpenWhispr uses the same approach: always setIgnoreMouseEvents(false) on Windows.
    // Trade-off: transparent areas of the overlay window block desktop clicks behind
    // it, but this is acceptable (same as OpenWhispr's design decision).
    if (process.platform === "win32") {
      this.mainWindow.setIgnoreMouseEvents(false);
      this.isMainWindowInteractive = shouldCapture;
      return;
    }

    if (shouldCapture) {
      this.mainWindow.setIgnoreMouseEvents(false);
    } else {
      this.mainWindow.setIgnoreMouseEvents(true, { forward: true });
    }
    this.isMainWindowInteractive = shouldCapture;
  }

  suspendMainWindowOverlay() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    // Windows compositor sensitivity: when the overlay is hidden, fully drop
    // always-on-top so transparent window layering cannot interfere with
    // windowed games (e.g. Minecraft/Tekkit camera stutter reports).
    if (process.platform === "win32") {
      this.mainWindow.setAlwaysOnTop(false);
      this.isMainWindowOverlaySuspended = true;
    }
  }

  resumeMainWindowOverlay() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    if (process.platform === "win32" && this.isMainWindowOverlaySuspended) {
      this.isMainWindowOverlaySuspended = false;
      this.enforceMainWindowOnTop();
    }
  }

  resizeMainWindow(sizeKey) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false };
    }

    const newSize = WINDOW_SIZES[sizeKey] || WINDOW_SIZES.BASE;
    const currentBounds = this.mainWindow.getBounds();

    const { screen } = require("electron");
    const display = screen.getDisplayNearestPoint({
      x: currentBounds.x + currentBounds.width / 2,
      y: currentBounds.y + currentBounds.height,
    });
    const workArea = display.workArea || display.bounds;

    // Anchor: bottom-right corner stays fixed, window expands left and up
    const bottomRightX = currentBounds.x + currentBounds.width;
    const bottomY = currentBounds.y + currentBounds.height;
    let newX = bottomRightX - newSize.width;
    let newY = bottomY - newSize.height;

    // Clamp to work area
    newX = Math.max(workArea.x, Math.min(newX, workArea.x + workArea.width - newSize.width));
    newY = Math.max(workArea.y, Math.min(newY, workArea.y + workArea.height - newSize.height));

    this.mainWindow.setBounds({ x: newX, y: newY, width: newSize.width, height: newSize.height });
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
    this.mainWindowRendererReady = false;
    await this.loadWindowContent(this.mainWindow, false);
  }

  markMainWindowRendererReady() {
    this.mainWindowRendererReady = true;
  }

  async waitForMainWindowRendererReady(timeoutMs = 1500) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return false;
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) {
        return false;
      }
      if (this.mainWindowRendererReady) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return false;
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

      // When overlay is disabled, create the window hidden (not shown) and send
      // dictation IPC to it. The hidden renderer handles audio recording without
      // any visible overlay, eliminating DWM lag in windowed games.
      if (this.overlayDisabled) {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) {
          await this.createMainWindow();
        }
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send("toggle-dictation");
        }
        return;
      }

      const dictationWindow = await this.showDictationPanel();
      if (!dictationWindow || dictationWindow.isDestroyed()) {
        return;
      }
      dictationWindow.moveTop(); // Force z-order refresh on Windows
      dictationWindow.webContents.send("toggle-dictation");
    };
  }

  async sendStartDictation() {
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }

    // When overlay is disabled, create the window hidden (not shown) and send
    // dictation IPC to it. The hidden renderer handles audio recording without
    // any visible overlay, eliminating DWM lag in windowed games.
    if (this.overlayDisabled) {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) {
        await this.createMainWindow();
      }
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("start-dictation");
      }
      return;
    }

    const dictationWindow = await this.showDictationPanel();
    if (dictationWindow && !dictationWindow.isDestroyed()) {
      dictationWindow.webContents.send("start-dictation");
    }
  }

  sendStopDictation() {
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }

    // When overlay is disabled, send stop to the hidden main window
    if (this.overlayDisabled) {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("stop-dictation");
      }
      return;
    }

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("stop-dictation");
    }
  }

  async getActivationMode() {
    const hostWindow = this.getHotkeyHostWindow();
    if (!hostWindow) {
      return this.activationModeCache;
    }
    try {
      const mode = await hostWindow.webContents.executeJavaScript(
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

  getHotkeyHostWindow() {
    if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
      return this.controlPanelWindow;
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      return this.mainWindow;
    }
    return null;
  }

  async initializeHotkey(hostWindow = this.getHotkeyHostWindow()) {
    if (!hostWindow || hostWindow.isDestroyed()) {
      debugLogger.warn("[Hotkey] No live window available for hotkey initialization");
      return;
    }
    await this.hotkeyManager.initializeHotkey(hostWindow, this.createHotkeyCallback());
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

  async createControlPanelWindow(options = {}) {
    // On Windows, start minimized to taskbar so there's a persistent taskbar
    // entry even when the user hasn't opened the control panel yet.
    // (The overlay is skipTaskbar:true to avoid game compositor issues, so
    // this is the only taskbar presence on Windows.)
    this._controlPanelStartMinimized = options.startMinimized ?? (process.platform === "win32");
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
      if (this._controlPanelStartMinimized) {
        // Show minimized to taskbar — gives Windows a taskbar entry without
        // stealing focus on startup (the overlay is now skipTaskbar:true so
        // this is the only persistent taskbar presence).
        this.controlPanelWindow.minimize();
        this.controlPanelWindow.showInactive();
      } else {
        this.controlPanelWindow.show();
        this.controlPanelWindow.focus();
      }
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
    await this.initializeHotkey(this.controlPanelWindow);
  }

  async loadControlPanel() {
    await this.loadWindowContent(this.controlPanelWindow, true);
  }

  async showDictationPanel(options = {}) {
    const { focus = false } = options;
    if (isEnvFlagEnabled("PRIVATETRANSCRIBE_DIAG_DISABLE_OVERLAY_WINDOW")) {
      debugLogger.warn("[Diagnostics] Dictation overlay requested but disabled by env flag");
      return null;
    }

    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      await this.createMainWindow();
    }

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      if (!this.mainWindow.isVisible()) {
        this.resumeMainWindowOverlay();
        if (typeof this.mainWindow.showInactive === "function") {
          this.mainWindow.showInactive();
        } else {
          this.mainWindow.show();
        }
      }
      if (focus) {
        this.mainWindow.focus();
      }
      this._notifyOverlayStateChanged();
      return this.mainWindow;
    }

    return null;
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
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    // When overlay is disabled, destroy the window completely to eliminate
    // DWM composition lag in windowed games (Windows issue with transparent
    // always-on-top BrowserWindow).
    if (this.overlayDisabled) {
      this.mainWindow.close();
      // mainWindow will be nulled in the 'closed' event handler
      return;
    }

    this.suspendMainWindowOverlay();
    this.mainWindow.hide();
  }

  setOverlayDisabled(disabled) {
    const changed = this.overlayDisabled !== disabled;
    this.overlayDisabled = disabled;

    if (changed) {
      debugLogger.info("[Overlay] Overlay disabled state changed:", disabled);
      if (disabled) {
        // Destroy overlay immediately when disabling
        this.hideDictationPanel();
      } else {
        // Show overlay when re-enabling
        this.showDictationPanel();
      }
      // Notify tray so menu labels update
      this._notifyOverlayStateChanged();
    }
  }

  isOverlayDisabled() {
    return this.overlayDisabled;
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
      // When overlay is disabled, keep the window hidden to avoid DWM lag.
      // Dictation still works in the background via the hidden renderer.
      if (this.overlayDisabled) {
        debugLogger.debug("[Overlay] Window ready but overlayDisabled=true, keeping hidden");
        return;
      }
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
      this._notifyOverlayStateChanged();
      // Notify renderer so it can restart the mic-level AudioContext if it was
      // suspended while the window was hidden (voice bars stuck bug).
      if (!this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("main-window-shown");
      }
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

      // Notify renderer so it can keep AudioContext alive when a game steals focus
      if (!this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("main-window-blur");
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
      this.resumeMainWindowOverlay();
      this.enforceMainWindowOnTop();
    });

    this.mainWindow.on("hide", () => {
      debugLogger.debug("[Window] main hide");
      this._notifyOverlayStateChanged();
    });

    this.mainWindow.on("moved", () => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        const btnPos = this._getButtonScreenPos();
        if (btnPos) this._scheduleSavePosition(btnPos.x, btnPos.y);
      }
    });

    this.mainWindow.on("closed", () => {
      if (this.mainWindowOnTopRepairTimer) {
        clearTimeout(this.mainWindowOnTopRepairTimer);
        this.mainWindowOnTopRepairTimer = null;
      }
      if (this._displayMetricsTimer) {
        clearTimeout(this._displayMetricsTimer);
        this._displayMetricsTimer = null;
      }
      if (this._powerResumeHandler) {
        powerMonitor.removeListener("resume", this._powerResumeHandler);
        this._powerResumeHandler = null;
      }
      if (this._displayMetricsChangedHandler) {
        screen.removeListener("display-metrics-changed", this._displayMetricsChangedHandler);
        this._displayMetricsChangedHandler = null;
      }
      if (this._positionSaveTimer) {
        clearTimeout(this._positionSaveTimer);
        this._positionSaveTimer = null;

        // If we were mid-debounce when the app is closed, flush the last seen position immediately.
        this._flushPendingOverlayPosition("closed");
      }
      this.dragManager.cleanup();
      this.mainWindow = null;
      this.mainWindowRendererReady = false;
      this.isMainWindowInteractive = false;
      this.isMainWindowOverlaySuspended = false;
      this._notifyOverlayStateChanged();
    });
  }

  enforceMainWindowOnTop() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      if (process.platform === "win32" && this.isMainWindowOverlaySuspended) {
        return;
      }
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
