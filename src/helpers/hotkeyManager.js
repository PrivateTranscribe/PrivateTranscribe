const { globalShortcut } = require("electron");
const debugLogger = require("./debugLogger");
const GnomeShortcutManager = require("./gnomeShortcut");

// Delay to ensure localStorage is accessible after window load
const HOTKEY_REGISTRATION_DELAY_MS = 1000;

// Suggested alternative hotkeys when registration fails
const SUGGESTED_HOTKEYS = {
  single: ["F8", "F9", "F10", "Pause", "ScrollLock"],
  compound: [
    "CommandOrControl+Shift+Space",
    "CommandOrControl+Shift+D",
    "Alt+Space",
    "CommandOrControl+`",
  ],
};

const isDiagFlagEnabled = (name) => {
  const raw = String(process.env[name] || "")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
};

// Keys that Electron globalShortcut cannot handle. These must be routed through
// native OS listeners (WindowsKeyManager on Windows, etc.) or rejected.
const NON_ACCELERATOR_KEYS = new Set([
  "Mouse4",
  "Mouse5",
  "XButton1",
  "XButton2",
  "½",
  "§",
  "°",
  "´",
  "`",
  "¨",
  "^",
  "~",
]);

// Valid accelerator key names per Electron docs (partial list for validation).
// See: https://www.electronjs.org/docs/latest/api/accelerator
const VALID_ELECTRON_KEYS = new Set([
  // Modifiers
  "Command",
  "Cmd",
  "Control",
  "Ctrl",
  "CommandOrControl",
  "CmdOrCtrl",
  "Alt",
  "Option",
  "AltGr",
  "Shift",
  "Super",
  "Meta",
  "Win",
  // Special keys
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
  "F13",
  "F14",
  "F15",
  "F16",
  "F17",
  "F18",
  "F19",
  "F20",
  "F21",
  "F22",
  "F23",
  "F24",
  "Plus",
  "Space",
  "Tab",
  "Backspace",
  "Delete",
  "Insert",
  "Return",
  "Enter",
  "Up",
  "Down",
  "Left",
  "Right",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Escape",
  "Esc",
  "VolumeUp",
  "VolumeDown",
  "VolumeMute",
  "MediaNextTrack",
  "MediaPreviousTrack",
  "MediaStop",
  "MediaPlayPause",
  "PrintScreen",
  "Numlock",
  "Scrolllock",
  "Capslock",
  // Mouse buttons (Electron doesn't support these via globalShortcut, but we list them for completeness)
  "LeftButton",
  "RightButton",
  "MiddleButton",
  // Digits
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  // Letters
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
  "O",
  "P",
  "Q",
  "R",
  "S",
  "T",
  "U",
  "V",
  "W",
  "X",
  "Y",
  "Z",
  // Numpad
  "num0",
  "num1",
  "num2",
  "num3",
  "num4",
  "num5",
  "num6",
  "num7",
  "num8",
  "num9",
  "numadd",
  "numsub",
  "nummult",
  "numdiv",
  "numdec",
]);

function isValidAccelerator(hotkey) {
  if (!hotkey || typeof hotkey !== "string") return false;

  // Check for known non-accelerator keys first
  const baseKey = hotkey.includes("+") ? hotkey.split("+").pop().trim() : hotkey.trim();
  if (NON_ACCELERATOR_KEYS.has(baseKey)) return false;

  // Validate each part of the accelerator
  const parts = hotkey.split("+").map((p) => p.trim());
  for (const part of parts) {
    // Allow numpad keys with 'num' prefix (case-insensitive)
    if (/^num\d$/.test(part.toLowerCase())) continue;
    if (/^num(add|sub|mult|div|dec)$/.test(part.toLowerCase())) continue;
    if (!VALID_ELECTRON_KEYS.has(part)) {
      // Unknown key — likely not a valid accelerator
      return false;
    }
  }
  return true;
}

class HotkeyManager {
  constructor() {
    this.currentHotkey = "`";
    this.isInitialized = false;
    this.isListeningMode = false;
    this.gnomeManager = null;
    this.useGnome = false;
    this.hotkeyCallback = null;
    this.activationMode = "tap";
  }

  setActivationMode(mode) {
    this.activationMode = mode === "push" ? "push" : "tap";
    debugLogger.log(`[HotkeyManager] Activation mode set to: ${this.activationMode}`);
  }

  setListeningMode(enabled) {
    this.isListeningMode = enabled;
    debugLogger.log(`[HotkeyManager] Listening mode: ${enabled ? "enabled" : "disabled"}`);
  }

  isInListeningMode() {
    return this.isListeningMode;
  }

  isMouseHotkey(hotkey) {
    if (!hotkey) return false;
    const base = hotkey.includes("+") ? hotkey.split("+").pop() : hotkey;
    return base === "Mouse4" || base === "Mouse5" || base === "XButton1" || base === "XButton2";
  }

  getFailureReason(hotkey) {
    if (globalShortcut.isRegistered(hotkey)) {
      return {
        reason: "already_registered",
        message: `"${hotkey}" is already registered by another application.`,
        suggestions: this.getSuggestions(hotkey),
      };
    }

    if (process.platform === "win32") {
      // Windows reserves certain keys
      const winReserved = ["PrintScreen", "Win", "Super"];
      if (winReserved.some((k) => hotkey.includes(k))) {
        return {
          reason: "os_reserved",
          message: `"${hotkey}" is reserved by Windows.`,
          suggestions: this.getSuggestions(hotkey),
        };
      }
    }

    if (process.platform === "linux") {
      // Linux DE's often reserve Super/Meta combinations
      if (hotkey.includes("Super") || hotkey.includes("Meta")) {
        return {
          reason: "os_reserved",
          message: `"${hotkey}" may be reserved by your desktop environment.`,
          suggestions: this.getSuggestions(hotkey),
        };
      }
    }

    return {
      reason: "registration_failed",
      message: `Could not register "${hotkey}". It may be in use by another application.`,
      suggestions: this.getSuggestions(hotkey),
    };
  }

  getSuggestions(failedHotkey) {
    const isCompound = failedHotkey.includes("+");
    const suggestions = isCompound
      ? [...SUGGESTED_HOTKEYS.compound]
      : [...SUGGESTED_HOTKEYS.single];

    return suggestions.filter((s) => s !== failedHotkey).slice(0, 3);
  }

  setupShortcuts(hotkey = "`", callback) {
    if (!callback) {
      throw new Error("Callback function is required for hotkey setup");
    }

    debugLogger.log(`[HotkeyManager] Setting up hotkey: "${hotkey}"`);
    debugLogger.log(`[HotkeyManager] Platform: ${process.platform}, Arch: ${process.arch}`);
    debugLogger.log(`[HotkeyManager] Current hotkey: "${this.currentHotkey}"`);

    if (isDiagFlagEnabled("PRIVATETRANSCRIBE_DIAG_DISABLE_GLOBAL_SHORTCUT")) {
      this.currentHotkey = hotkey;
      this.hotkeyCallback = callback;
      debugLogger.warn(`[Diagnostics] Skipping globalShortcut registration for "${hotkey}"`);
      return {
        success: true,
        hotkey,
        diagnostic: "globalShortcut registration disabled by environment flag",
      };
    }

    // Validate the hotkey before attempting registration.
    // This prevents Electron crashes on keys like "½" that it cannot parse.
    const isValid = isValidAccelerator(hotkey);
    const isMouse = this.isMouseHotkey(hotkey);
    if (!isValid && !isMouse && hotkey !== "GLOBE") {
      debugLogger.warn(
        `[HotkeyManager] Invalid accelerator "${hotkey}" — not a key globalShortcut can handle`
      );
      const suggestions = this.getSuggestions(hotkey);
      return {
        success: false,
        error: `"${hotkey}" is not a supported hotkey. Mouse buttons and special characters cannot be used with global shortcuts. Try: ${suggestions.join(", ")}`,
        reason: "unsupported_key",
        suggestions,
      };
    }

    // If we're already using this hotkey AND it's actually registered, return success
    if (
      hotkey === this.currentHotkey &&
      hotkey !== "GLOBE" &&
      !isMouse &&
      globalShortcut.isRegistered(hotkey)
    ) {
      debugLogger.log(
        `[HotkeyManager] Hotkey "${hotkey}" is already the current hotkey and registered, no change needed`
      );
      return { success: true, hotkey };
    }

    // Unregister the previous hotkey (if it's not GLOBE or a mouse hotkey)
    if (
      this.currentHotkey &&
      this.currentHotkey !== "GLOBE" &&
      !this.isMouseHotkey(this.currentHotkey)
    ) {
      debugLogger.log(`[HotkeyManager] Unregistering previous hotkey: "${this.currentHotkey}"`);
      globalShortcut.unregister(this.currentHotkey);
    }

    try {
      if (hotkey === "GLOBE") {
        if (process.platform !== "darwin") {
          debugLogger.log("[HotkeyManager] GLOBE key rejected - not on macOS");
          return {
            success: false,
            error: "The Globe key is only available on macOS.",
          };
        }
        this.currentHotkey = hotkey;
        debugLogger.log("[HotkeyManager] GLOBE key set successfully");
        return { success: true, hotkey };
      }

      // Mouse side buttons are not supported by Electron globalShortcut.
      // On Windows, these are handled by the native WindowsKeyManager listener (push-to-talk).
      if (process.platform === "win32" && isMouse) {
        this.currentHotkey = hotkey;
        debugLogger.log(
          `[HotkeyManager] Mouse hotkey "${hotkey}" accepted (WindowsKeyManager handles it; globalShortcut not used)`
        );
        return {
          success: true,
          hotkey,
          message:
            "Mouse hotkeys require Windows Push-to-Talk mode (hold-to-talk). Tap-to-talk via globalShortcut is not available for mouse buttons.",
        };
      }

      const alreadyRegistered = globalShortcut.isRegistered(hotkey);
      debugLogger.log(`[HotkeyManager] Is "${hotkey}" already registered? ${alreadyRegistered}`);

      if (process.platform === "linux") {
        globalShortcut.unregister(hotkey);
      }

      // On Windows in push-to-talk mode, WindowsKeyManager owns dictation start/stop.
      // Wrapping the callback prevents globalShortcut from double-firing, while still
      // registering the key so other apps can't steal it.
      const effectiveCallback =
        process.platform === "win32"
          ? () => {
              if (this.activationMode !== "push") callback();
            }
          : callback;
      const success = globalShortcut.register(hotkey, effectiveCallback);
      debugLogger.log(`[HotkeyManager] Registration result for "${hotkey}": ${success}`);

      if (success) {
        this.currentHotkey = hotkey;
        debugLogger.log(`[HotkeyManager] Hotkey "${hotkey}" registered successfully`);
        return { success: true, hotkey };
      } else {
        const failureInfo = this.getFailureReason(hotkey);
        console.error(`[HotkeyManager] Failed to register hotkey: ${hotkey}`, failureInfo);
        debugLogger.log(`[HotkeyManager] Registration failed:`, failureInfo);

        let errorMessage = failureInfo.message;
        if (failureInfo.suggestions.length > 0) {
          errorMessage += ` Try: ${failureInfo.suggestions.join(", ")}`;
        }

        return {
          success: false,
          error: errorMessage,
          reason: failureInfo.reason,
          suggestions: failureInfo.suggestions,
        };
      }
    } catch (error) {
      console.error("[HotkeyManager] Error setting up shortcuts:", error);
      debugLogger.log(`[HotkeyManager] Exception during registration:`, error.message);
      return { success: false, error: error.message };
    }
  }

  async initializeGnomeShortcuts(callback) {
    if (process.platform !== "linux" || !GnomeShortcutManager.isWayland()) {
      return false;
    }

    if (GnomeShortcutManager.isGnome()) {
      try {
        this.gnomeManager = new GnomeShortcutManager();

        const dbusOk = await this.gnomeManager.initDBusService(callback);
        if (dbusOk) {
          this.useGnome = true;
          this.hotkeyCallback = callback;
          return true;
        }
      } catch (err) {
        debugLogger.log("[HotkeyManager] GNOME shortcut init failed:", err.message);
        this.gnomeManager = null;
        this.useGnome = false;
      }
    }

    return false;
  }

  async initializeHotkey(mainWindow, callback) {
    if (!mainWindow || !callback) {
      throw new Error("mainWindow and callback are required");
    }

    this.mainWindow = mainWindow;
    this.hotkeyCallback = callback;

    if (process.platform === "linux" && GnomeShortcutManager.isWayland()) {
      const gnomeOk = await this.initializeGnomeShortcuts(callback);

      if (gnomeOk) {
        const registerGnomeHotkey = async () => {
          try {
            const savedHotkey = await mainWindow.webContents.executeJavaScript(`
              localStorage.getItem("dictationKey") || ""
            `);
            const hotkey = savedHotkey && savedHotkey.trim() !== "" ? savedHotkey : "Alt+R";
            const gnomeHotkey = GnomeShortcutManager.convertToGnomeFormat(hotkey);

            const success = await this.gnomeManager.registerKeybinding(gnomeHotkey);
            if (success) {
              this.currentHotkey = hotkey;
              debugLogger.log(`[HotkeyManager] GNOME hotkey "${hotkey}" registered successfully`);
            } else {
              debugLogger.log("[HotkeyManager] GNOME keybinding failed, falling back to X11");
              this.useGnome = false;
              this.loadSavedHotkeyOrDefault(mainWindow, callback);
            }
          } catch (err) {
            debugLogger.log(
              "[HotkeyManager] GNOME keybinding failed, falling back to X11:",
              err.message
            );
            this.useGnome = false;
            this.loadSavedHotkeyOrDefault(mainWindow, callback);
          }
        };

        setTimeout(registerGnomeHotkey, HOTKEY_REGISTRATION_DELAY_MS);
        this.isInitialized = true;
        return;
      }
    }

    if (process.platform === "linux") {
      globalShortcut.unregisterAll();
    }

    setTimeout(() => {
      this.loadSavedHotkeyOrDefault(mainWindow, callback);
    }, HOTKEY_REGISTRATION_DELAY_MS);

    this.isInitialized = true;
  }

  async loadSavedHotkeyOrDefault(mainWindow, callback) {
    try {
      // First check file-based storage (environment variable) - more reliable
      let savedHotkey = process.env.DICTATION_KEY || "";

      // Fall back to localStorage if env var is empty
      if (!savedHotkey) {
        savedHotkey = await mainWindow.webContents.executeJavaScript(`
          localStorage.getItem("dictationKey") || ""
        `);

        // If we found a hotkey in localStorage but not in env, migrate it
        if (savedHotkey && savedHotkey.trim() !== "") {
          process.env.DICTATION_KEY = savedHotkey;
          debugLogger.log(
            `[HotkeyManager] Migrated hotkey "${savedHotkey}" from localStorage to env`
          );
        }
      }

      if (savedHotkey && savedHotkey.trim() !== "") {
        const result = this.setupShortcuts(savedHotkey, callback);
        if (result.success) {
          debugLogger.log(`[HotkeyManager] Restored saved hotkey: "${savedHotkey}"`);
          return;
        }
        debugLogger.log(`[HotkeyManager] Saved hotkey "${savedHotkey}" failed to register`);
        this.notifyHotkeyFailure(savedHotkey, result);
      }

      const defaultHotkey = process.platform === "darwin" ? "GLOBE" : "`";

      if (defaultHotkey === "GLOBE") {
        this.currentHotkey = "GLOBE";
        debugLogger.log("[HotkeyManager] Using GLOBE key as default on macOS");
        return;
      }

      const result = this.setupShortcuts(defaultHotkey, callback);
      if (result.success) {
        debugLogger.log(
          `[HotkeyManager] Default hotkey "${defaultHotkey}" registered successfully`
        );
        return;
      }

      debugLogger.log(
        `[HotkeyManager] Default hotkey "${defaultHotkey}" failed, trying fallbacks...`
      );
      const fallbackHotkeys = ["F8", "F9", "CommandOrControl+Shift+Space"];

      for (const fallback of fallbackHotkeys) {
        const fallbackResult = this.setupShortcuts(fallback, callback);
        if (fallbackResult.success) {
          debugLogger.log(`[HotkeyManager] Fallback hotkey "${fallback}" registered successfully`);
          await this.saveHotkeyToRenderer(fallback);
          this.notifyHotkeyFallback(defaultHotkey, fallback);
          return;
        }
      }

      debugLogger.log("[HotkeyManager] All hotkey fallbacks failed");
      this.notifyHotkeyFailure(defaultHotkey, result);
    } catch (err) {
      console.error("Failed to initialize hotkey:", err);
      debugLogger.error("[HotkeyManager] Failed to initialize hotkey:", err.message);
    }
  }

  async saveHotkeyToRenderer(hotkey) {
    // Escape the hotkey string to prevent injection issues
    const escapedHotkey = hotkey.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

    // Save to environment variable for file-based persistence (more reliable)
    process.env.DICTATION_KEY = hotkey;

    // Persist to .env file for reliable startup
    try {
      // Lazy require to avoid circular dependencies
      const EnvironmentManager = require("./environment");
      const envManager = new EnvironmentManager();
      envManager.saveAllKeysToEnvFile();
      debugLogger.log(`[HotkeyManager] Saved hotkey "${hotkey}" to .env file`);
    } catch (err) {
      debugLogger.warn("[HotkeyManager] Failed to persist hotkey to .env file:", err.message);
    }

    // Also save to localStorage for backwards compatibility
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      try {
        await this.mainWindow.webContents.executeJavaScript(
          `localStorage.setItem("dictationKey", "${escapedHotkey}"); true;`
        );
        debugLogger.log(`[HotkeyManager] Saved hotkey "${hotkey}" to localStorage`);
        return true;
      } catch (err) {
        debugLogger.error("[HotkeyManager] Failed to save hotkey to localStorage:", err.message);
        return false;
      }
    } else {
      debugLogger.warn(
        "[HotkeyManager] Main window not available for saving hotkey to localStorage"
      );
      return false;
    }
  }

  notifyHotkeyFallback(originalHotkey, fallbackHotkey) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("hotkey-fallback-used", {
        original: originalHotkey,
        fallback: fallbackHotkey,
        message: `The "${originalHotkey}" key was unavailable. Using "${fallbackHotkey}" instead. You can change this in Settings.`,
      });
    }
  }

  notifyHotkeyFailure(hotkey, result) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("hotkey-registration-failed", {
        hotkey,
        error: result?.error || `Could not register "${hotkey}"`,
        suggestions: result?.suggestions || ["F8", "F9", "CommandOrControl+Shift+Space"],
      });
    }
  }

  async updateHotkey(hotkey, callback) {
    if (!callback) {
      throw new Error("Callback function is required for hotkey update");
    }

    try {
      if (this.useGnome && this.gnomeManager) {
        debugLogger.log(`[HotkeyManager] Updating GNOME hotkey to "${hotkey}"`);
        const gnomeHotkey = GnomeShortcutManager.convertToGnomeFormat(hotkey);
        const success = await this.gnomeManager.updateKeybinding(gnomeHotkey);
        if (!success) {
          return {
            success: false,
            message: `Failed to update GNOME hotkey to "${hotkey}". Check the format is valid.`,
          };
        }
        this.currentHotkey = hotkey;
        const saved = await this.saveHotkeyToRenderer(hotkey);
        if (!saved) {
          debugLogger.warn(
            "[HotkeyManager] GNOME hotkey registered but failed to persist to localStorage"
          );
        }
        return {
          success: true,
          message: `Hotkey updated to: ${hotkey} (via GNOME native shortcut)`,
        };
      }

      const result = this.setupShortcuts(hotkey, callback);
      if (result.success) {
        const saved = await this.saveHotkeyToRenderer(hotkey);
        if (!saved) {
          debugLogger.warn(
            "[HotkeyManager] Hotkey registered but failed to persist to localStorage"
          );
        }
        return {
          success: true,
          message: result.message || `Hotkey updated to: ${hotkey}`,
        };
      } else {
        return {
          success: false,
          message: result.error,
          suggestions: result.suggestions,
        };
      }
    } catch (error) {
      debugLogger.error("[HotkeyManager] Failed to update hotkey:", error.message);
      return {
        success: false,
        message: `Failed to update hotkey: ${error.message}`,
      };
    }
  }

  getCurrentHotkey() {
    return this.currentHotkey;
  }

  unregisterAll() {
    if (this.gnomeManager) {
      this.gnomeManager.unregisterKeybinding().catch((err) => {
        debugLogger.warn("[HotkeyManager] Error unregistering GNOME keybinding:", err.message);
      });
      this.gnomeManager.close();
      this.gnomeManager = null;
      this.useGnome = false;
    }
    globalShortcut.unregisterAll();
  }

  isUsingGnome() {
    return this.useGnome;
  }

  isHotkeyRegistered(hotkey) {
    return globalShortcut.isRegistered(hotkey);
  }
}

module.exports = HotkeyManager;
