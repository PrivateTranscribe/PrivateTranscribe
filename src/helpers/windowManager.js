const path = require("path");
const fs = require("fs");
const { app, screen, powerMonitor, BrowserWindow, dialog } = require("electron");
const HotkeyManager = require("./hotkeyManager");
const { normalizeActivationMode } = HotkeyManager;
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
  BUTTON_HALF,
  WindowPositionUtil,
} = require("./windowConfig");

const BUTTON_HIT_TEST_PADDING = 4;
const BUTTON_HOVER_POLL_MS = 50;

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
    // Overlay visibility mode — the single source of truth for whether the
    // dictation overlay should be on screen. Owned by the main process.
    //   "shown"   — normal, overlay visible
    //   "snoozed" — temporarily hidden (window kept alive), auto-restores at
    //               overlaySnoozeUntil; never persisted across restarts
    //   "off"     — persistently disabled; the window is destroyed to avoid
    //               DWM composition lag, dictation still works via hotkey
    this.overlayMode = "shown";
    this.overlaySnoozeUntil = null;
    this._overlaySnoozeTimer = null;
    this._overlayModeFile = null;
    this.overlaySnapToTaskbar = false;

    // Overlay stability: debounced re-apply always-on-top after blur/focus races.
    // Applies on Windows and Linux (incl. Unity desktop); macOS is exempt - the
    // "floating" panel level is managed reliably by the compositor there.
    this.mainWindowOnTopRepairTimer = null;

    // Position persistence
    this._positionFile = null;
    this._positionSaveTimer = null;
    this._pendingPosition = null;
    this._displayMetricsTimer = null;
    this._interactivityRefreshTimer = null;
    this._powerResumeHandler = null;
    this._powerUnlockHandler = null;
    this._displayMetricsChangedHandler = null;
    this._displayAddedHandler = null;
    this._displayRemovedHandler = null;
    this._overlayRecoveryTimers = new Set();
    this._lastKnownButtonPosition = null;
    this._ignoreOverlayMoveSaveUntil = 0;
    this._hoverInteractivityTimer = null;
    this._overlayMouseCaptured = null;

    this._registerExitHandlers();
    this._loadPersistedOverlayMode();

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
    this.activationModeCache = normalizeActivationMode(mode);
  }

  setOverlayStateChangeCallback(callback) {
    this._overlayStateChangeCallback = typeof callback === "function" ? callback : null;
  }

  _notifyOverlayStateChanged() {
    // Broadcast the current overlay state to every renderer so UI that
    // reflects it (Settings toggle, overlay menu) never drifts out of sync
    // with the main-process source of truth.
    const state = this.getOverlayState();
    for (const win of [this.mainWindow, this.controlPanelWindow]) {
      if (win && !win.isDestroyed()) {
        try {
          win.webContents.send("overlay-state-changed", state);
        } catch {
          // Window may be mid-teardown; the next state change re-broadcasts.
        }
      }
    }

    if (!this._overlayStateChangeCallback) {
      return;
    }

    try {
      this._overlayStateChangeCallback(this.mainWindow);
    } catch (error) {
      debugLogger.debug("[Window] Overlay state callback failed:", error?.message || String(error));
    }
  }

  _notifyOverlayRendererResumed(reason) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    try {
      this.mainWindow.webContents.send("main-window-shown");
    } catch (error) {
      debugLogger.debug("[Window] Failed to notify overlay renderer resume:", {
        reason,
        error: error?.message || String(error),
      });
    }
  }

  // Distinct from "main-window-shown": fired only for real power resume /
  // screen unlock, so renderers can invalidate audio resources (warm mic
  // stream, audio graph) that Windows silently kills during sleep, without
  // also invalidating them on every ordinary window show.
  _notifySystemResumed(reason) {
    for (const win of [this.mainWindow, this.controlPanelWindow]) {
      if (!win || win.isDestroyed()) {
        continue;
      }
      try {
        win.webContents.send("system-resumed", { reason });
      } catch (error) {
        debugLogger.debug("[Window] Failed to notify renderer of system resume:", {
          reason,
          error: error?.message || String(error),
        });
      }
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
    if (Number.isFinite(x) && Number.isFinite(y)) {
      this._lastKnownButtonPosition = { x, y };
    }
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

  _constrainOverlayPosition(x, y, width, height, display) {
    const workArea = display.workArea || display.bounds;
    if (this.overlaySnapToTaskbar) {
      return WindowPositionUtil.getTaskbarSnappedPosition(x, y, width, height, display);
    }
    return WindowPositionUtil.clampPosition(x, y, width, height, workArea);
  }

  _sendOverlayDragReset(reason) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    try {
      this.mainWindow.webContents.send("window-drag-reset", { reason });
    } catch (error) {
      debugLogger.debug(
        "[Window] Failed to send overlay drag reset:",
        error?.message || String(error)
      );
    }
  }

  _resetOverlayDragState(reason) {
    this.dragManager.resetDragState();
    this._sendOverlayDragReset(reason);
  }

  _clearOverlayRecoveryTimers() {
    for (const timer of this._overlayRecoveryTimers) {
      clearTimeout(timer);
    }
    this._overlayRecoveryTimers.clear();
  }

  _scheduleOverlayRecovery(reason, delays = [2500, 6000]) {
    this._clearOverlayRecoveryTimers();

    for (const delay of delays) {
      const timer = setTimeout(() => {
        this._overlayRecoveryTimers.delete(timer);
        this._reclampOverlayPosition(`${reason}:${delay}`, {
          preferLastKnownButtonPosition: true,
          persistPosition: false,
        });
        this._refreshMainWindowInteractivity(`${reason}:${delay}`);
      }, delay);
      this._overlayRecoveryTimers.add(timer);
    }
  }

  _reclampOverlayPosition(reason, options = {}) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    const { preferLastKnownButtonPosition = false, persistPosition = true } = options;
    const bounds = this.mainWindow.getBounds();
    const { width, height } = bounds;
    const currentButtonPosition = {
      x: bounds.x + BUTTON_OFFSET_X,
      y: bounds.y + BUTTON_OFFSET_Y,
    };
    const targetButtonPosition =
      preferLastKnownButtonPosition && this._lastKnownButtonPosition
        ? this._lastKnownButtonPosition
        : currentButtonPosition;
    const targetBounds = {
      x: targetButtonPosition.x - BUTTON_OFFSET_X,
      y: targetButtonPosition.y - BUTTON_OFFSET_Y,
    };
    // Use button screen position for display detection (more accurate than window center).
    const display = screen.getDisplayNearestPoint({
      x: targetButtonPosition.x,
      y: targetButtonPosition.y,
    });
    const clamped = this._constrainOverlayPosition(
      targetBounds.x,
      targetBounds.y,
      CONTAINER_W,
      CONTAINER_H,
      display
    );
    // Also correct the size: repeated repositioning on fractional-DPI displays
    // can leave the fixed container a few pixels off, which shifts the
    // bottom-anchored mic button on screen.
    const sizeDrifted = width !== CONTAINER_W || height !== CONTAINER_H;
    if (clamped.x !== bounds.x || clamped.y !== bounds.y || sizeDrifted) {
      debugLogger.info("[Window] Re-clamping overlay after", reason, {
        from: { x: bounds.x, y: bounds.y, width, height },
        to: clamped,
        targetButtonPosition,
        workArea: display.workArea || display.bounds,
        snapToTaskbar: this.overlaySnapToTaskbar,
        persistPosition,
        sizeDrifted,
      });
      if (!persistPosition) {
        this._ignoreOverlayMoveSaveUntil = Date.now() + 5000;
      }
      this.mainWindow.setBounds({
        x: clamped.x,
        y: clamped.y,
        width: CONTAINER_W,
        height: CONTAINER_H,
      });
      if (persistPosition) {
        this._scheduleSavePosition(clamped.x + BUTTON_OFFSET_X, clamped.y + BUTTON_OFFSET_Y);
      }
    } else {
      debugLogger.debug("[Window] Overlay already within bounds after", reason);
    }
    // Always re-enforce z-order after any reclamping — the window may have lost its
    // always-on-top level during sleep/wake or display-metrics changes, which causes
    // it to appear behind the taskbar even if the position is correct.
    this.enforceMainWindowOnTop();
  }

  async createMainWindow(options = {}) {
    const initialShowDelayMs = Math.max(0, Number(options.initialShowDelayMs) || 0);
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
      this._lastKnownButtonPosition = { x: btnX, y: btnY };
      const winX = btnX - BUTTON_OFFSET_X;
      const winY = btnY - BUTTON_OFFSET_Y;
      const savedDisplay = screen.getDisplayNearestPoint({ x: btnX, y: btnY });
      const clamped = this._constrainOverlayPosition(
        winX,
        winY,
        CONTAINER_W,
        CONTAINER_H,
        savedDisplay
      );
      position = { ...clamped, width: CONTAINER_W, height: CONTAINER_H };
    } else {
      const defaultPosition = WindowPositionUtil.getMainWindowPosition(display);
      const constrained = this._constrainOverlayPosition(
        defaultPosition.x,
        defaultPosition.y,
        CONTAINER_W,
        CONTAINER_H,
        display
      );
      position = { ...constrained, width: CONTAINER_W, height: CONTAINER_H };
      this._lastKnownButtonPosition = {
        x: constrained.x + BUTTON_OFFSET_X,
        y: constrained.y + BUTTON_OFFSET_Y,
      };
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
    this.registerMainWindowEvents({ initialShowDelayMs });

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
    this.dragManager.setTaskbarSnapEnabled(this.overlaySnapToTaskbar);
    this.dragManager.setPositionChangeCallback((winX, winY) => {
      this._scheduleSavePosition(winX + BUTTON_OFFSET_X, winY + BUTTON_OFFSET_Y);
    });
    MenuManager.setupMainMenu();

    // Re-clamp the overlay after sleep/wake against the last user-chosen button
    // anchor. Windows can briefly report the wrong monitor/workArea on wake; do
    // not persist those temporary clamps or the overlay drifts after the display settles.
    this._powerResumeHandler = () => {
      // Reset any stuck drag state: if sleep interrupted an active drag the
      // isDragging flag stays true, causing startWindowDrag() to return early and
      // leaving the overlay unmovable after wake.
      this._resetOverlayDragState("resume");
      this._notifyOverlayRendererResumed("resume");
      this._notifySystemResumed("resume");
      this._scheduleOverlayRecovery("resume");
    };
    powerMonitor.on("resume", this._powerResumeHandler);

    this._powerUnlockHandler = () => {
      this._resetOverlayDragState("unlock-screen");
      this._notifyOverlayRendererResumed("unlock-screen");
      this._notifySystemResumed("unlock-screen");
      this._scheduleOverlayRecovery("unlock-screen", [500, 2500, 6000]);
    };
    powerMonitor.on("unlock-screen", this._powerUnlockHandler);

    // Re-clamp whenever the display resolution, scale, or work area changes.
    // Debounce: this event fires many times during sleep/wake and screen on/off while
    // the work area is in flux (taskbar not yet registered, DPI not yet settled).
    // Firing immediately can save a wrong clamped position, which persists across reboots.
    // Wait 2 s after the last event so we act on the final stable work area.
    this._displayMetricsChangedHandler = () => {
      if (this._displayMetricsTimer) clearTimeout(this._displayMetricsTimer);
      this._displayMetricsTimer = setTimeout(() => {
        this._displayMetricsTimer = null;
        this._resetOverlayDragState("display-metrics-changed");
        this._reclampOverlayPosition("display-metrics-changed", {
          preferLastKnownButtonPosition: true,
          persistPosition: false,
        });
        this._refreshMainWindowInteractivity("display-metrics-changed");
      }, 2000);
    };
    screen.on("display-metrics-changed", this._displayMetricsChangedHandler);

    this._displayAddedHandler = () => {
      this._displayMetricsChangedHandler();
    };
    this._displayRemovedHandler = () => {
      this._displayMetricsChangedHandler();
    };
    screen.on("display-added", this._displayAddedHandler);
    screen.on("display-removed", this._displayRemovedHandler);
  }

  setMainWindowInteractivity(shouldCapture) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    this.isMainWindowInteractive = shouldCapture;

    if (process.platform === "win32") {
      if (shouldCapture) {
        this._stopHoverInteractivityProbe();
        this._setMainWindowMouseCapture(true);
      } else {
        this._startHoverInteractivityProbe();
        this._refreshHoverInteractivity("set-interactivity");
      }
      return;
    }

    this._setMainWindowMouseCapture(shouldCapture);
  }

  _setMainWindowMouseCapture(shouldCapture) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    if (this._overlayMouseCaptured === shouldCapture) {
      return;
    }

    if (shouldCapture) {
      this.mainWindow.setIgnoreMouseEvents(false);
    } else {
      this.mainWindow.setIgnoreMouseEvents(true, { forward: true });
    }
    this._overlayMouseCaptured = shouldCapture;
  }

  _isCursorOverOverlayButton() {
    if (!this.mainWindow || this.mainWindow.isDestroyed() || !this.mainWindow.isVisible()) {
      return false;
    }

    const cursor = screen.getCursorScreenPoint();
    const bounds = this.mainWindow.getBounds();
    const dx = cursor.x - (bounds.x + BUTTON_OFFSET_X);
    const dy = cursor.y - (bounds.y + BUTTON_OFFSET_Y);
    const radius = BUTTON_HALF + BUTTON_HIT_TEST_PADDING;
    return dx * dx + dy * dy <= radius * radius;
  }

  _refreshHoverInteractivity(reason) {
    if (this.isMainWindowInteractive) {
      return;
    }

    try {
      // Do not depend on Electron's forwarded mouse-enter events after sleep.
      // Poll the cursor against the real mic circle so only the button captures
      // input and the transparent/glow area remains click-through.
      this._setMainWindowMouseCapture(
        this.dragManager.isDragActive() || this._isCursorOverOverlayButton()
      );
    } catch (error) {
      debugLogger.debug("[Window] Failed to refresh overlay hover interactivity:", {
        reason,
        error: error?.message || String(error),
      });
      this._setMainWindowMouseCapture(false);
    }
  }

  _startHoverInteractivityProbe() {
    if (process.platform !== "win32" || this._hoverInteractivityTimer) {
      return;
    }

    this._hoverInteractivityTimer = setInterval(() => {
      this._refreshHoverInteractivity("hover-probe");
    }, BUTTON_HOVER_POLL_MS);
  }

  _stopHoverInteractivityProbe() {
    if (this._hoverInteractivityTimer) {
      clearInterval(this._hoverInteractivityTimer);
      this._hoverInteractivityTimer = null;
    }
  }

  _refreshMainWindowInteractivity(reason) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    if (this._interactivityRefreshTimer) {
      clearTimeout(this._interactivityRefreshTimer);
      this._interactivityRefreshTimer = null;
    }

    const shouldCapture = this.isMainWindowInteractive;

    try {
      // After display sleep/wake, Electron's forwarded mouse-event hook can get
      // stale while the transparent overlay remains visible. Toggling capture
      // re-arms the native ignore/forward state so hover can make the mic button
      // interactive again for dragging.
      this.setMainWindowInteractivity(true);
      this._interactivityRefreshTimer = setTimeout(() => {
        this._interactivityRefreshTimer = null;
        this.setMainWindowInteractivity(shouldCapture);
      }, 150);
      debugLogger.debug("[Window] Refreshed overlay interactivity", { reason, shouldCapture });
    } catch (error) {
      debugLogger.warn("[Window] Failed to refresh overlay interactivity", {
        reason,
        error: error?.message || String(error),
      });
    }
  }

  refreshMainWindowInteractivity(reason = "manual") {
    this._refreshMainWindowInteractivity(reason);
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
    this.mainWindowRendererReady = false;
    await this.loadWindowContent(this.mainWindow, false);
  }

  markMainWindowRendererReady() {
    this.mainWindowRendererReady = true;
    // Startup recovery path: this must stay immediate. Electron's ready-to-show
    // event can leave the transparent overlay hidden on some Windows setups, so
    // renderer-ready is the last reliable signal that the window can be shown.
    // Do not route this through the cosmetic startup delay.
    if (
      this.mainWindow &&
      !this.mainWindow.isDestroyed() &&
      !this.mainWindow.isVisible() &&
      !this.isOverlaySuppressed()
    ) {
      this.resumeMainWindowOverlay();
      this.enforceMainWindowOnTop();
      if (typeof this.mainWindow.showInactive === "function") {
        this.mainWindow.showInactive();
      } else {
        this.mainWindow.show();
      }
    }
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
        if (this.activationModeCache !== "tap") {
          return;
        }

        // If windowsKeyManager is actively listening, we're in push mode
        // even if the cache hasn't been updated yet (startup race)
        if (this._windowsKeyManagerRef?.isReady) {
          return;
        }

        const activationMode = await this.getActivationMode();
        if (activationMode !== "tap") {
          return;
        }
      }

      const now = Date.now();
      if (now - lastToggleTime < DEBOUNCE_MS) {
        return;
      }
      lastToggleTime = now;

      // While the overlay is snoozed or off, keep it invisible and send the
      // dictation IPC to the hidden renderer. It handles audio recording
      // without any visible overlay, eliminating DWM lag in windowed games —
      // and a snoozed overlay must not pop back up just because the user dictated.
      if (this.isOverlaySuppressed()) {
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

    // While the overlay is snoozed or off, create the window hidden (not shown)
    // and send dictation IPC to it. The hidden renderer handles audio recording
    // without any visible overlay, eliminating DWM lag in windowed games.
    if (this.isOverlaySuppressed()) {
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

    // While the overlay is snoozed or off, send stop to the hidden main window
    if (this.isOverlaySuppressed()) {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("stop-dictation");
      }
      return;
    }

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("stop-dictation");
    }
  }

  async sendHybridDictationKeyDown() {
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }

    if (this.isOverlaySuppressed()) {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) {
        await this.createMainWindow();
      }
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("hybrid-dictation-key-down");
      }
      return;
    }

    const dictationWindow = await this.showDictationPanel();
    if (dictationWindow && !dictationWindow.isDestroyed()) {
      dictationWindow.webContents.send("hybrid-dictation-key-down");
    }
  }

  sendHybridDictationKeyUp() {
    if (this.hotkeyManager.isInListeningMode()) {
      return;
    }

    if (this.isOverlaySuppressed()) {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send("hybrid-dictation-key-up");
      }
      return;
    }

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("hybrid-dictation-key-up");
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

  async setSessionHotkeyEnabled(enabled) {
    const result = await this.hotkeyManager.setSessionHotkeyEnabled(enabled);
    if (!result.success || process.platform !== "win32" || !this._windowsKeyManagerRef) {
      return result;
    }

    this._windowsKeyManagerRef.stop();
    if (enabled) {
      const hotkey = this.hotkeyManager.getCurrentHotkey();
      const activationMode = await this.getActivationMode();
      if (
        hotkey &&
        hotkey !== "GLOBE" &&
        (activationMode !== "tap" || this.hotkeyManager.isNativeListenerHotkey(hotkey))
      ) {
        this._windowsKeyManagerRef.start(hotkey);
      }
    }

    return result;
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
    this._controlPanelStartHidden = options.startHidden === true;
    this._controlPanelStartMinimized =
      !this._controlPanelStartHidden && (options.startMinimized ?? process.platform === "win32");
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

    const visibilityTimer = this._controlPanelStartHidden
      ? null
      : setTimeout(() => {
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
      if (visibilityTimer) {
        clearTimeout(visibilityTimer);
      }
    };

    this.controlPanelWindow.once("ready-to-show", () => {
      clearVisibilityTimer();
      // Show dock icon on macOS when control panel opens
      if (process.platform === "darwin" && app.dock) {
        app.dock.show();
      }
      if (this._controlPanelStartHidden) {
        debugLogger.debug(
          "[Window] Control panel ready but startup mode is tray-only, keeping hidden"
        );
      } else if (this._controlPanelStartMinimized) {
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

    // Never show the overlay while it is snoozed or off — callers that want
    // to bring it back must go through setOverlayMode("shown"). This is the
    // guard that prevents stray show paths from resurrecting a hidden overlay.
    if (this.isOverlaySuppressed()) {
      debugLogger.debug("[Overlay] showDictationPanel suppressed, mode:", this.overlayMode);
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
      this.enforceMainWindowOnTop();
      if (typeof this.mainWindow.moveTop === "function") {
        this.mainWindow.moveTop();
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

    // Overlay mode "off" means "no visual overlay window exists", not just
    // "temporarily hidden". Destroying is intentional here to eliminate DWM
    // composition lag in windowed games (Windows issue with transparent
    // always-on-top BrowserWindow). Snooze and normal hiding keep the window alive.
    if (this.overlayMode === "off") {
      this.mainWindow.close();
      // mainWindow will be nulled in the 'closed' event handler
      return;
    }

    this.suspendMainWindowOverlay();
    this.mainWindow.hide();
  }

  _getOverlayModeFile() {
    if (!this._overlayModeFile) {
      this._overlayModeFile = path.join(app.getPath("userData"), "overlay-state.json");
    }
    return this._overlayModeFile;
  }

  _loadPersistedOverlayMode() {
    // Only "shown" and "off" are persisted; a snooze never survives a restart.
    try {
      const raw = fs.readFileSync(this._getOverlayModeFile(), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && (parsed.mode === "shown" || parsed.mode === "off")) {
        this.overlayMode = parsed.mode;
        debugLogger.info("[Overlay] Loaded persisted overlay mode:", parsed.mode);
      }
    } catch {
      // No persisted state yet — default "shown".
    }
  }

  _persistOverlayMode(mode) {
    try {
      fs.writeFileSync(this._getOverlayModeFile(), JSON.stringify({ mode, v: 1 }), "utf8");
    } catch (err) {
      debugLogger.warn("[Overlay] Failed to persist overlay mode:", err?.message || String(err));
    }
  }

  hasPersistedOverlayMode() {
    try {
      return fs.existsSync(this._getOverlayModeFile());
    } catch {
      return false;
    }
  }

  getOverlayState() {
    return {
      mode: this.overlayMode,
      snoozeUntil: this.overlayMode === "snoozed" ? this.overlaySnoozeUntil : null,
    };
  }

  _clearOverlaySnoozeTimer() {
    if (this._overlaySnoozeTimer) {
      clearTimeout(this._overlaySnoozeTimer);
      this._overlaySnoozeTimer = null;
    }
  }

  /**
   * Transition the overlay to a new mode. This is the ONLY place overlay
   * visibility policy changes — tray, Settings toggle, and the overlay's own
   * menu all route here so state can never fork.
   */
  setOverlayMode(mode, options = {}) {
    if (mode !== "shown" && mode !== "snoozed" && mode !== "off") {
      debugLogger.warn("[Overlay] Ignoring invalid overlay mode:", mode);
      return this.getOverlayState();
    }

    const prevMode = this.overlayMode;
    this._clearOverlaySnoozeTimer();
    this.overlayMode = mode;

    if (mode === "snoozed") {
      const requestedUntil = Number(options.snoozeUntil);
      const untilMs = Number.isFinite(requestedUntil)
        ? requestedUntil
        : Date.now() + 60 * 60 * 1000;
      const delay = Math.max(1000, untilMs - Date.now());
      this.overlaySnoozeUntil = untilMs;
      this._overlaySnoozeTimer = setTimeout(() => {
        this._overlaySnoozeTimer = null;
        if (this.overlayMode === "snoozed") {
          debugLogger.info("[Overlay] Snooze elapsed — restoring overlay");
          this.setOverlayMode("shown");
        }
      }, delay);
    } else {
      this.overlaySnoozeUntil = null;
      this._persistOverlayMode(mode);
    }

    if (prevMode !== mode) {
      debugLogger.info("[Overlay] Overlay mode changed:", { from: prevMode, to: mode });
      if (mode === "off") {
        // Destroy the window to eliminate DWM composition lag.
        this.hideDictationPanel();
      } else if (mode === "snoozed") {
        // Keep the window alive so the snooze can restore instantly.
        this.hideDictationPanel();
      } else {
        this.showDictationPanel();
      }
    }

    this._notifyOverlayStateChanged();
    return this.getOverlayState();
  }

  snoozeOverlay(durationMs) {
    const duration = Number(durationMs);
    if (!Number.isFinite(duration) || duration <= 0) {
      debugLogger.warn("[Overlay] Ignoring invalid snooze duration:", durationMs);
      return this.getOverlayState();
    }
    return this.setOverlayMode("snoozed", { snoozeUntil: Date.now() + duration });
  }

  /**
   * One-time migration from the legacy renderer-owned localStorage flag.
   * Applies only when the main process has never persisted a mode itself,
   * so it can never override a choice made through the new controls.
   */
  migrateLegacyOverlayDisabled(disabled) {
    if (this.hasPersistedOverlayMode()) {
      return false;
    }
    debugLogger.info("[Overlay] Migrating legacy overlayDisabled flag:", disabled);
    this.setOverlayMode(disabled ? "off" : "shown");
    return true;
  }

  isOverlayDisabled() {
    return this.overlayMode === "off";
  }

  /** True when the overlay must not be shown automatically (snoozed or off). */
  isOverlaySuppressed() {
    return this.overlayMode !== "shown";
  }

  setOverlaySnapToTaskbar(enabled) {
    const next = enabled === true;
    const changed = this.overlaySnapToTaskbar !== next;
    this.overlaySnapToTaskbar = next;
    this.dragManager.setTaskbarSnapEnabled(next);

    if (changed) {
      debugLogger.info("[Overlay] Taskbar snap state changed:", next);
      if (next) {
        this._reclampOverlayPosition("taskbar-snap-enabled");
      } else {
        this._reclampOverlayPosition("taskbar-snap-disabled");
      }
      this.enforceMainWindowOnTop();
    }
  }

  isOverlaySnapToTaskbarEnabled() {
    return this.overlaySnapToTaskbar;
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

  registerMainWindowEvents(options = {}) {
    if (!this.mainWindow) {
      return;
    }
    const initialShowDelayMs = Math.max(0, Number(options.initialShowDelayMs) || 0);

    // Safety timeout: force show the window if ready-to-show doesn't fire within 10 seconds
    const showTimeout = setTimeout(() => {
      if (this.mainWindow && !this.mainWindow.isDestroyed() && !this.mainWindow.isVisible()) {
        this.mainWindow.show();
      }
    }, 10000);

    this.mainWindow.once("ready-to-show", () => {
      clearTimeout(showTimeout);
      this.enforceMainWindowOnTop();
      // While the overlay is snoozed or off, keep the window hidden to avoid
      // DWM lag. Dictation still works in the background via the hidden renderer.
      if (this.isOverlaySuppressed()) {
        debugLogger.debug("[Overlay] Window ready but overlay suppressed, keeping hidden");
        return;
      }
      const showOverlay = () => {
        if (!this.mainWindow || this.mainWindow.isDestroyed() || this.mainWindow.isVisible()) {
          return;
        }
        if (this.isOverlaySuppressed()) {
          return;
        }
        if (typeof this.mainWindow.showInactive === "function") {
          this.mainWindow.showInactive();
        } else {
          this.mainWindow.show();
        }
      };

      if (initialShowDelayMs > 0) {
        setTimeout(showOverlay, initialShowDelayMs);
      } else {
        showOverlay();
      }
    });

    this.mainWindow.on("show", () => {
      this.enforceMainWindowOnTop();
      this._notifyOverlayStateChanged();
      // Notify renderer so it can restart the mic-level AudioContext if it was
      // suspended while the window was hidden (voice bars stuck bug).
      this._notifyOverlayRendererResumed("show");
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

      const repairDelayMs = this.overlaySnapToTaskbar ? 1000 : 100;
      this.mainWindowOnTopRepairTimer = setTimeout(() => {
        this.mainWindowOnTopRepairTimer = null;
        this.enforceMainWindowOnTop();
      }, repairDelayMs);
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
        if (Date.now() < this._ignoreOverlayMoveSaveUntil) {
          return;
        }
        const [x, y] = this.mainWindow.getPosition();
        this._scheduleSavePosition(x + BUTTON_OFFSET_X, y + BUTTON_OFFSET_Y);
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
      if (this._interactivityRefreshTimer) {
        clearTimeout(this._interactivityRefreshTimer);
        this._interactivityRefreshTimer = null;
      }
      this._stopHoverInteractivityProbe();
      this._clearOverlayRecoveryTimers();
      if (this._powerResumeHandler) {
        powerMonitor.removeListener("resume", this._powerResumeHandler);
        this._powerResumeHandler = null;
      }
      if (this._powerUnlockHandler) {
        powerMonitor.removeListener("unlock-screen", this._powerUnlockHandler);
        this._powerUnlockHandler = null;
      }
      if (this._displayMetricsChangedHandler) {
        screen.removeListener("display-metrics-changed", this._displayMetricsChangedHandler);
        this._displayMetricsChangedHandler = null;
      }
      if (this._displayAddedHandler) {
        screen.removeListener("display-added", this._displayAddedHandler);
        this._displayAddedHandler = null;
      }
      if (this._displayRemovedHandler) {
        screen.removeListener("display-removed", this._displayRemovedHandler);
        this._displayRemovedHandler = null;
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
      WindowPositionUtil.setupAlwaysOnTop(this.mainWindow, {
        aboveTaskbar: this.overlaySnapToTaskbar,
      });
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
