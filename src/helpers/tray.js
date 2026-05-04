const { Tray, Menu, nativeImage, app } = require("electron");
const path = require("path");
const fs = require("fs");

class TrayManager {
  constructor() {
    this.tray = null;
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this.windowManager = null;
    this.attachedWindows = new WeakSet();
  }

  setWindows(mainWindow, controlPanelWindow) {
    this.mainWindow = mainWindow;
    this.controlPanelWindow = controlPanelWindow;

    this.attachMainWindowListeners(this.mainWindow);

    if (this.controlPanelWindow) {
      this.attachControlPanelListeners(this.controlPanelWindow);
    }

    this.updateTrayMenu?.();
  }

  setWindowManager(windowManager) {
    this.windowManager = windowManager;
    this.windowManager?.setOverlayStateChangeCallback?.((mainWindow) => {
      this.mainWindow = mainWindow;
      this.attachMainWindowListeners(mainWindow);
      this.updateTrayMenu?.();
    });
  }

  setCreateControlPanelCallback(callback) {
    this.createControlPanelCallback = callback;
  }

  attachMainWindowListeners(window) {
    if (!window || this.attachedWindows.has(window)) {
      return;
    }

    this.attachedWindows.add(window);

    window.on("show", () => this.updateTrayMenu?.());
    window.on("hide", () => this.updateTrayMenu?.());
    window.on("minimize", () => this.updateTrayMenu?.());
    window.on("restore", () => this.updateTrayMenu?.());
    window.on("closed", () => {
      if (this.mainWindow === window) {
        this.mainWindow = null;
      }
      this.updateTrayMenu?.();
    });
  }

  attachControlPanelListeners(window) {
    if (!window || this.attachedWindows.has(window)) {
      return;
    }

    this.attachedWindows.add(window);

    window.on("show", () => {
      this.updateTrayMenu?.();
    });

    window.on("hide", () => {
      this.updateTrayMenu?.();
    });

    window.on("destroyed", () => {
      this.controlPanelWindow = null;
      this.updateTrayMenu?.();
    });
  }

  async showControlPanelFromTray() {
    try {
      if (this.windowManager) {
        this.controlPanelWindow = this.windowManager.controlPanelWindow || this.controlPanelWindow;
      }
      this.attachControlPanelListeners(this.controlPanelWindow);

      if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
        // Show dock icon on macOS when control panel opens
        if (process.platform === "darwin" && app.dock) {
          app.dock.show();
        }
        if (this.controlPanelWindow.isMinimized()) {
          this.controlPanelWindow.restore();
        }
        if (!this.controlPanelWindow.isVisible()) {
          this.controlPanelWindow.show();
        }
        this.controlPanelWindow.focus();
        return;
      }

      if (this.createControlPanelCallback) {
        await this.createControlPanelCallback();
        if (this.windowManager) {
          this.controlPanelWindow =
            this.windowManager.controlPanelWindow || this.controlPanelWindow;
        }
        this.attachControlPanelListeners(this.controlPanelWindow);

        if (this.controlPanelWindow && !this.controlPanelWindow.isDestroyed()) {
          this.controlPanelWindow.show();
          this.controlPanelWindow.focus();
        }
        return;
      }

      console.error("No control panel callback available");
    } catch (error) {
      console.error("Failed to open control panel:", error);
    }
  }

  async createTray() {
    if (process.platform !== "darwin" && process.platform !== "win32") return;

    try {
      const trayIcon = await this.loadTrayIcon();
      if (!trayIcon || trayIcon.isEmpty()) {
        console.error("Failed to load tray icon");
        return;
      }

      this.tray = new Tray(trayIcon);

      if (process.platform === "darwin") {
        this.tray.setIgnoreDoubleClickEvents(true);
      }

      this.updateTrayMenu();
      this.setupTrayEventHandlers();
    } catch (error) {
      console.error("Error creating tray icon:", error.message);
    }
  }

  async loadTrayIcon() {
    const platform = process.platform;
    const isDevelopment = process.env.NODE_ENV === "development";

    const candidatePaths = [];

    if (platform === "darwin") {
      if (isDevelopment) {
        candidatePaths.push(path.join(__dirname, "..", "assets", "iconTemplate@3x.png"));
      } else {
        candidatePaths.push(
          path.join(process.resourcesPath, "src", "assets", "iconTemplate@3x.png"),
          path.join(process.resourcesPath, "assets", "iconTemplate@3x.png"),
          path.join(
            process.resourcesPath,
            "app.asar.unpacked",
            "src",
            "assets",
            "iconTemplate@3x.png"
          ),
          path.join(__dirname, "..", "..", "src", "assets", "iconTemplate@3x.png"),
          path.join(app.getAppPath(), "src", "assets", "iconTemplate@3x.png")
        );
      }
    } else {
      const fileName = platform === "win32" ? "icon.ico" : "icon.png";
      if (isDevelopment) {
        candidatePaths.push(
          path.join(__dirname, "..", "assets", fileName),
          path.join(__dirname, "..", "assets", "icon.png")
        );
      } else {
        candidatePaths.push(
          path.join(process.resourcesPath, "src", "assets", fileName),
          path.join(process.resourcesPath, "assets", fileName),
          path.join(process.resourcesPath, "app.asar.unpacked", "src", "assets", fileName),
          path.join(__dirname, "..", "..", "src", "assets", fileName),
          path.join(app.getAppPath(), "src", "assets", fileName)
        );
      }
    }

    for (const testPath of candidatePaths) {
      try {
        if (fs.existsSync(testPath)) {
          const icon = nativeImage.createFromPath(testPath);
          if (icon && !icon.isEmpty()) {
            if (platform === "darwin") {
              icon.setTemplateImage(true);
            }
            console.log("Using tray icon:", testPath);
            return icon;
          }
        }
      } catch (error) {
        console.error("Error checking tray icon path:", testPath, error.message);
      }
    }

    console.error("Could not find tray icon in any expected location");
    return this.createFallbackIcon();
  }

  createFallbackIcon() {
    try {
      // Create a simple 16x16 PNG icon programmatically
      const { createCanvas } = require("canvas");
      const canvas = createCanvas(16, 16);
      const ctx = canvas.getContext("2d");

      ctx.fillStyle = "#000000";
      ctx.beginPath();
      ctx.arc(8, 8, 6, 0, 2 * Math.PI);
      ctx.fill();

      const buffer = canvas.toBuffer("image/png");
      const fallbackIcon = nativeImage.createFromBuffer(buffer);
      console.log("✅ Created fallback tray icon");
      return fallbackIcon;
    } catch (fallbackError) {
      console.warn("Canvas not available, creating minimal fallback icon");
      // Create a minimal 16x16 black square PNG as fallback
      const pngData = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
        0x91, 0x68, 0x36, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x28, 0x53, 0x63, 0x08,
        0x05, 0x00, 0x00, 0x02, 0x00, 0x01, 0xe5, 0x27, 0xde, 0xfc, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]);

      const fallbackIcon = nativeImage.createFromBuffer(pngData);
      console.log("✅ Created minimal fallback tray icon");
      return fallbackIcon;
    }
  }

  buildContextMenuTemplate() {
    const dictationVisible = this.windowManager?.isDictationPanelVisible?.() ?? false;

    const items = [
      {
        label: dictationVisible ? "Hide Dictation Panel" : "Show Dictation Panel",
        click: () => {
          if (!this.windowManager) return;
          if (this.windowManager.isDictationPanelVisible()) {
            this.windowManager.hideDictationPanel();
          } else {
            this.windowManager.showDictationPanel({ focus: true });
          }
          this.updateTrayMenu();
        },
      },
    ];

    if (
      process.platform === "win32" &&
      this.windowManager?.mainWindow &&
      !this.windowManager.mainWindow.isDestroyed()
    ) {
      items.push({
        label: "Close Dictation Panel",
        click: () => {
          if (!this.windowManager) return;
          this.windowManager.mainWindow?.close?.();
          this.updateTrayMenu();
        },
      });
    }

    items.push(
      {
        label: "Open PrivateTranscribe",
        click: async () => {
          await this.showControlPanelFromTray();
        },
      },
      { type: "separator" },
      {
        label: "Exit PrivateTranscribe",
        click: () => {
          console.log("Quitting app via tray menu");
          app.quit();
        },
      }
    );

    return items;
  }

  updateTrayMenu() {
    if (!this.tray) return;

    const contextMenu = Menu.buildFromTemplate(this.buildContextMenuTemplate());
    this.tray.setToolTip("PrivateTranscribe");
    this.tray.setContextMenu(contextMenu);
  }

  setupTrayEventHandlers() {
    if (!this.tray) {
      return;
    }

    if (process.platform === "win32") {
      this.tray.on("click", () => {
        void this.showControlPanelFromTray();
      });
      this.tray.on("right-click", () => {
        this.updateTrayMenu();
        this.tray?.popUpContextMenu();
      });
    } else {
      this.tray.on("click", () => {
        this.tray?.popUpContextMenu();
      });
    }

    this.tray.on("destroyed", () => {
      console.log("Tray icon destroyed — attempting recovery");
      this.tray = null;
      this.attemptTrayRecovery();
    });
  }

  /**
   * Attempt to recreate the tray icon after unexpected destruction.
   * Retries up to 3 times with exponential backoff.
   */
  attemptTrayRecovery(attempt = 1) {
    const maxAttempts = 3;
    if (attempt > maxAttempts) {
      console.error(`Tray recovery failed after ${maxAttempts} attempts`);
      return;
    }
    if (this.tray) return; // Already recovered

    const delayMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
    console.log(`Tray recovery attempt ${attempt}/${maxAttempts} in ${delayMs}ms`);

    setTimeout(async () => {
      if (this.tray) return; // Recovered in the meantime
      try {
        await this.createTray();
        if (this.tray) {
          console.log("Tray icon recovered successfully");
        } else {
          this.attemptTrayRecovery(attempt + 1);
        }
      } catch (error) {
        console.error(`Tray recovery attempt ${attempt} failed:`, error.message);
        this.attemptTrayRecovery(attempt + 1);
      }
    }, delayMs);
  }

  /**
   * Start a periodic health check that verifies the tray icon still exists.
   * Call once after initial createTray(). Checks every 30 seconds.
   *
   * On Windows, the tray icon can silently vanish from the notification area
   * after Explorer crashes or restarts — WITHOUT triggering the `destroyed`
   * event. The standard workaround is to periodically call setImage() to force
   * Windows to re-register the icon in the shell notification area.
   */
  startHealthCheck() {
    if (this._healthCheckInterval) return;

    // Check every 30 seconds: if tray object is destroyed, recover it
    this._healthCheckInterval = setInterval(() => {
      if (!this.tray || this.tray.isDestroyed?.()) {
        console.warn("Tray health check: icon missing, triggering recovery");
        this.tray = null;
        this.attemptTrayRecovery();
      }
    }, 30000);

    // Windows only: re-register the tray icon every 5 minutes to survive
    // Explorer restarts. The icon silently disappears but the Tray object
    // remains valid, so setImage() forces Windows to re-show it.
    if (process.platform === "win32") {
      this._winReRegisterInterval = setInterval(
        async () => {
          if (!this.tray || this.tray.isDestroyed?.()) return;
          try {
            const icon = await this.loadTrayIcon();
            if (icon && !icon.isEmpty()) {
              this.tray.setImage(icon);
            }
          } catch (err) {
            console.warn("Tray re-registration failed:", err.message);
          }
        },
        5 * 60 * 1000
      ); // every 5 minutes
    }
  }

  /**
   * Stop the health check (call on app quit).
   */
  stopHealthCheck() {
    if (this._healthCheckInterval) {
      clearInterval(this._healthCheckInterval);
      this._healthCheckInterval = null;
    }
    if (this._winReRegisterInterval) {
      clearInterval(this._winReRegisterInterval);
      this._winReRegisterInterval = null;
    }
  }
}

module.exports = TrayManager;
