/**
 * The global hold-to-talk key for Agent Mode.
 *
 * Outside HotkeyManager for the same reason ReadAloudHotkey is: that module is
 * one dictation hotkey with its own native listener, GNOME D-Bus path and
 * fallback suggestions, and folding a second key into it would mean reworking
 * the one path dictation depends on. It drives a WindowsKeyManager rather than
 * globalShortcut because Electron cannot see key-up and cannot bind a bare
 * modifier, and a hold gesture needs both.
 */

const WindowsKeyManager = require("./windowsKeyManager");
const ActivationGestureController = require("./activationGestureController");
const debugLogger = require("./debugLogger");

const DEFAULT_AGENT_MODE_HOTKEY = "RightControl";
const DEFAULT_HOLD_THRESHOLD_MS = 150;

const LISTENER_KEY_CODES = {
  rightcontrol: "0xA3",
  leftcontrol: "0xA2",
  rightalt: "0xA5",
  leftalt: "0xA4",
  rightshift: "0xA1",
  leftshift: "0xA0",
};

/**
 * Maps the friendly names the renderer stores onto what the listener binary
 * parses. Anything else passes through: `F8`, `Pause` and `CommandOrControl+F9`
 * are already handled by ParseKeyCode in resources/windows-key-listener.c.
 */
function toListenerKey(hotkey) {
  const raw = String(hotkey ?? "").trim();
  return LISTENER_KEY_CODES[raw.toLowerCase()] || raw;
}

const isDiagFlagEnabled = (name) => {
  const raw = String(process.env[name] || "")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
};

class AgentModeHotkey {
  constructor({
    onHoldStart,
    onHoldEnd,
    createKeyManager = () => new WindowsKeyManager(),
    holdThresholdMs = DEFAULT_HOLD_THRESHOLD_MS,
  } = {}) {
    this.onHoldStart = onHoldStart;
    this.onHoldEnd = onHoldEnd;
    this.createKeyManager = createKeyManager;
    this.keyManager = null;
    this.boundHandlers = null;
    /** The listener key currently handed to a running child process, or null. */
    this.activeKey = null;
    this.registered = false;
    this.reason = "disabled";
    this.lastRequest = { enabled: false, hotkey: DEFAULT_AGENT_MODE_HOTKEY };

    this.gesture = new ActivationGestureController({
      mode: "push",
      holdThresholdMs,
      onHoldStart: () => this.invoke(this.onHoldStart, "onHoldStart"),
      onHoldEnd: () => this.invoke(this.onHoldEnd, "onHoldEnd"),
    });
  }

  apply({ enabled = true, hotkey = DEFAULT_AGENT_MODE_HOTKEY } = {}) {
    const friendly = String(hotkey || "").trim() || DEFAULT_AGENT_MODE_HOTKEY;
    this.lastRequest = { enabled: Boolean(enabled), hotkey: friendly };

    if (!this.lastRequest.enabled) {
      this.stopListening();
      this.reason = "disabled";
      return this.result();
    }

    if (process.platform !== "win32") {
      this.stopListening();
      this.reason = "windows-only";
      return this.result();
    }

    if (isDiagFlagEnabled("PRIVATETRANSCRIBE_DIAG_DISABLE_WINDOWS_KEY_LISTENER")) {
      this.stopListening();
      this.reason = "diagnostic-flag";
      debugLogger.warn(`[AgentMode] Skipping key listener for "${friendly}"`);
      return this.result();
    }

    const listenerKey = toListenerKey(friendly);
    if (this.activeKey === listenerKey && this.keyManager) {
      return this.result();
    }

    this.stopListening();
    this.reason = null;
    this.activeKey = listenerKey;

    const manager = this.createKeyManager();
    this.keyManager = manager;
    this.bind(manager);

    // While the key is held, Space still reaches a CommandOrControl+Space
    // dictation hotkey: the listener treats either Ctrl as the Ctrl family.
    // Accepted, because hands are off the keyboard while speaking.
    debugLogger.info(`[AgentMode] Starting key listener for "${friendly}" (${listenerKey})`);
    manager.start(listenerKey);

    return this.result();
  }

  reapply() {
    return this.apply(this.lastRequest);
  }

  suspend() {
    this.stopListening();
    this.reason = "suspended";
    return this.result();
  }

  unregister() {
    this.stopListening();
    this.reason = "disabled";
    this.lastRequest = { enabled: false, hotkey: this.lastRequest.hotkey };
  }

  getStatus() {
    const status = {
      registered: this.registered,
      hotkey: this.lastRequest.hotkey,
      enabled: this.lastRequest.enabled,
    };
    if (this.reason) {
      status.reason = this.reason;
    }
    return status;
  }

  result() {
    const value = { registered: this.registered, hotkey: this.lastRequest.hotkey };
    if (this.reason) {
      value.reason = this.reason;
    }
    return value;
  }

  invoke(callback, label) {
    try {
      Promise.resolve(callback?.()).catch((error) => {
        debugLogger.error(`[AgentMode] ${label} failed`, { error: error?.message });
      });
    } catch (error) {
      debugLogger.error(`[AgentMode] ${label} threw`, { error: error?.message });
    }
  }

  bind(manager) {
    const handlers = {
      ready: () => {
        this.registered = true;
        this.reason = null;
      },
      "key-down": () => this.gesture.keyDown(),
      "key-up": () => this.gesture.keyUp(),
      stopped: () => {
        this.registered = false;
        this.gesture.cancel();
      },
      error: () => {
        this.registered = false;
        this.reason = "unavailable";
        this.gesture.cancel();
      },
      unavailable: () => {
        this.registered = false;
        this.reason = "unavailable";
        this.gesture.cancel();
      },
    };

    for (const [event, handler] of Object.entries(handlers)) {
      manager.on(event, handler);
    }
    this.boundHandlers = handlers;
  }

  stopListening() {
    const manager = this.keyManager;
    const handlers = this.boundHandlers;
    this.keyManager = null;
    this.boundHandlers = null;
    this.activeKey = null;
    this.registered = false;

    // Before detaching, so a hold that is live when the listener goes away
    // still ends its recording instead of leaving audio ducked.
    this.gesture.cancel();

    if (!manager) return;
    if (handlers) {
      for (const [event, handler] of Object.entries(handlers)) {
        manager.off?.(event, handler);
      }
    }
    try {
      manager.stop();
    } catch (error) {
      debugLogger.warn("[AgentMode] Stopping the key listener threw", { error: error?.message });
    }
  }
}

module.exports = AgentModeHotkey;
module.exports.DEFAULT_AGENT_MODE_HOTKEY = DEFAULT_AGENT_MODE_HOTKEY;
module.exports.DEFAULT_HOLD_THRESHOLD_MS = DEFAULT_HOLD_THRESHOLD_MS;
module.exports.toListenerKey = toListenerKey;
