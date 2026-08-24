/**
 * The global shortcut that reads the current selection out loud.
 *
 * Deliberately not part of HotkeyManager. That module is built around a single
 * dictation hotkey with push-to-talk, native Windows hooks, GNOME D-Bus
 * shortcuts, and fallback suggestions; Read Aloud needs one accelerator and one
 * callback, and folding it in would mean reworking the one path dictation
 * depends on. This owns nothing but its own registration.
 *
 * Two things it must survive:
 *  - HotkeyManager calls globalShortcut.unregisterAll() when the dictation
 *    hotkey is re-registered or captured, which silently drops every other
 *    shortcut in the process. `reapply()` exists so the caller can put this one
 *    back afterwards.
 *  - e2e runs must never bind a machine-global key, so the same diagnostic flag
 *    HotkeyManager honours skips registration here too.
 */

const { globalShortcut } = require("electron");
const debugLogger = require("./debugLogger");

/** Matches the renderer's `readAloudHotkey` default in useSettings.ts. */
const DEFAULT_READ_ALOUD_HOTKEY = "Ctrl+Alt+R";

const isDiagFlagEnabled = (name) => {
  const raw = String(process.env[name] || "")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
};

class ReadAloudHotkey {
  /**
   * @param {() => Promise<unknown>|unknown} onTrigger Runs on every press.
   */
  constructor(onTrigger) {
    this.onTrigger = onTrigger;
    /** The accelerator currently held with the OS, or null. */
    this.registered = null;
    /** Last requested configuration, so reapply() has something to restore. */
    this.lastRequest = { enabled: false, hotkey: DEFAULT_READ_ALOUD_HOTKEY };
  }

  /**
   * Bring registration in line with `{ enabled, hotkey }`. Idempotent: calling
   * it repeatedly with the same values does not re-register.
   */
  apply({ enabled = false, hotkey = DEFAULT_READ_ALOUD_HOTKEY } = {}) {
    const accelerator = String(hotkey || "").trim() || DEFAULT_READ_ALOUD_HOTKEY;
    this.lastRequest = { enabled: Boolean(enabled), hotkey: accelerator };

    if (!enabled) {
      this.unregister();
      return { registered: false, hotkey: accelerator, reason: "disabled" };
    }

    if (isDiagFlagEnabled("PRIVATETRANSCRIBE_DIAG_DISABLE_GLOBAL_SHORTCUT")) {
      this.unregister();
      debugLogger.warn(`[ReadAloud] Skipping globalShortcut registration for "${accelerator}"`);
      return { registered: false, hotkey: accelerator, reason: "diagnostic-flag" };
    }

    if (this.registered === accelerator && globalShortcut.isRegistered(accelerator)) {
      return { registered: true, hotkey: accelerator };
    }

    this.unregister();

    try {
      const ok = globalShortcut.register(accelerator, () => {
        Promise.resolve()
          .then(() => this.onTrigger?.())
          .catch((error) => {
            debugLogger.error("[ReadAloud] Hotkey handler failed", { error: error?.message });
          });
      });

      if (!ok) {
        debugLogger.warn(`[ReadAloud] Could not register "${accelerator}" - already in use`);
        return { registered: false, hotkey: accelerator, reason: "unavailable" };
      }

      this.registered = accelerator;
      debugLogger.info(`[ReadAloud] Registered hotkey "${accelerator}"`);
      return { registered: true, hotkey: accelerator };
    } catch (error) {
      debugLogger.error("[ReadAloud] Hotkey registration threw", { error: error?.message });
      return { registered: false, hotkey: accelerator, reason: error?.message || "error" };
    }
  }

  /** Re-run the last apply(), for after something called unregisterAll(). */
  reapply() {
    const { enabled, hotkey } = this.lastRequest;
    if (enabled && this.registered === hotkey && globalShortcut.isRegistered(hotkey)) {
      return { registered: true, hotkey };
    }
    // The OS no longer holds it, whatever this object believed.
    this.registered = null;
    return this.apply(this.lastRequest);
  }

  unregister() {
    if (!this.registered) return;
    try {
      globalShortcut.unregister(this.registered);
    } catch {
      // Already gone, or the app is shutting down.
    }
    this.registered = null;
  }

  getStatus() {
    return {
      registered: Boolean(this.registered),
      hotkey: this.registered || this.lastRequest.hotkey,
      enabled: this.lastRequest.enabled,
    };
  }
}

module.exports = ReadAloudHotkey;
module.exports.DEFAULT_READ_ALOUD_HOTKEY = DEFAULT_READ_ALOUD_HOTKEY;
