/**
 * The keys that only exist while something is being read out loud.
 *
 * Read Aloud's own trigger is a permanent global shortcut (readAloudHotkey.js).
 * These three are the opposite: they are held only for the length of a read and
 * released the moment the pill leaves the overlay, so pausing playback never
 * costs the user a machine-wide binding they cannot type over the other 99% of
 * the time. The overlay tells the main process when a read starts and ends
 * (`readaloud-playback-active`), which is the only thing that turns them on.
 *
 * The defaults use Ctrl+Alt with Space or an arrow. Users can replace each
 * shortcut in Read Aloud settings. Changes during playback replace the held
 * keys; capture mode temporarily releases them so they reach the input.
 * Registration conflicts are logged and do not interrupt audio playback.
 *
 * `shortcuts` and `logger` are constructor-injectable because vitest cannot
 * mock a CommonJS `require("electron")` inside src/helpers - outside Electron
 * that require resolves to the npm package's binary path, so a unit test has to
 * hand the real dependencies in rather than replace the module.
 */

const { globalShortcut } = require("electron");
const debugLogger = require("./debugLogger");
const DEFAULT_PLAYBACK_HOTKEYS = require("../config/readAloudPlaybackHotkeys.json");

/** Accelerator -> the op sent to the overlay when it fires. */
const PLAYBACK_ACCELERATORS = Object.freeze(
  Object.fromEntries(Object.entries(DEFAULT_PLAYBACK_HOTKEYS).map(([op, key]) => [key, op]))
);

const isDiagFlagEnabled = (name) => {
  const raw = String(process.env[name] || "")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
};

class ReadAloudPlaybackKeys {
  /**
   * @param {(op: "toggle"|"back"|"forward") => void} onControl Runs on every press.
   * @param {{ shortcuts?: object, logger?: object }} [deps]
   */
  constructor(onControl, { shortcuts = globalShortcut, logger = debugLogger } = {}) {
    this.onControl = onControl;
    this.shortcuts = shortcuts || null;
    this.logger = logger;
    /** Accelerators currently held with the OS. */
    this.registered = [];
    /** Whether the last apply() asked for them to be held. */
    this.active = false;
    this.hotkeys = { ...DEFAULT_PLAYBACK_HOTKEYS };
    this.suspended = false;
  }

  /**
   * Hold the playback keys while `active`, release them otherwise. Idempotent:
   * the overlay may call this on any state change, and only a transition costs
   * anything.
   */
  apply({ active = false, hotkeys = this.hotkeys } = {}) {
    const want = Boolean(active);
    const nextHotkeys = Object.fromEntries(
      Object.entries(DEFAULT_PLAYBACK_HOTKEYS).map(([op, fallback]) => {
        const value = hotkeys?.[op];
        return [
          op,
          typeof value === "string" && value.trim() && value.length < 100 ? value.trim() : fallback,
        ];
      })
    );
    const changed = JSON.stringify(nextHotkeys) !== JSON.stringify(this.hotkeys);
    this.hotkeys = nextHotkeys;

    if (this.suspended) {
      this.active = want;
      return { active: want, registered: [] };
    }

    if (!want) {
      this.unregister();
      this.active = false;
      return { active: false, registered: [] };
    }

    if (isDiagFlagEnabled("PRIVATETRANSCRIBE_DIAG_DISABLE_GLOBAL_SHORTCUT")) {
      this.unregister();
      this.active = false;
      this.logger.warn("[ReadAloud] Skipping playback key registration (diagnostic flag)");
      return { active: false, registered: [], reason: "diagnostic-flag" };
    }

    if (
      !changed &&
      this.active &&
      this.registered.length > 0 &&
      this.registered.every(
        (key) => !this.shortcuts?.isRegistered || this.shortcuts.isRegistered(key)
      )
    ) {
      return { active: true, registered: [...this.registered] };
    }

    if (!this.shortcuts) {
      this.logger.warn("[ReadAloud] No globalShortcut API; playback keys stay unbound");
      return { active: false, registered: [], reason: "unavailable" };
    }

    this.unregister();

    for (const [op, accelerator] of Object.entries(this.hotkeys)) {
      try {
        const ok = this.shortcuts.register(accelerator, () => this.fire(op));
        if (ok) {
          this.registered.push(accelerator);
        } else {
          this.logger.warn(`[ReadAloud] Playback key "${accelerator}" is already in use`);
        }
      } catch (error) {
        this.logger.warn(`[ReadAloud] Playback key "${accelerator}" failed to register`, {
          error: error?.message,
        });
      }
    }

    this.active = true;
    return { active: true, registered: [...this.registered] };
  }

  /** Release keys while a settings field records a replacement. */
  suspend() {
    this.suspended = true;
    this.unregister();
  }

  resume() {
    this.suspended = false;
    return this.apply({ active: this.active });
  }

  /** Deliver one press. A throwing handler must never take the app down. */
  fire(op) {
    try {
      this.onControl?.(op);
    } catch (error) {
      this.logger.error("[ReadAloud] Playback key handler failed", { error: error?.message });
    }
  }

  unregister() {
    for (const accelerator of this.registered) {
      try {
        this.shortcuts?.unregister(accelerator);
      } catch {
        // Already gone, or the app is shutting down.
      }
    }
    this.registered = [];
  }

  getStatus() {
    return { active: this.active, registered: [...this.registered] };
  }
}

module.exports = ReadAloudPlaybackKeys;
module.exports.PLAYBACK_ACCELERATORS = PLAYBACK_ACCELERATORS;
