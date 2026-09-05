/**
 * Hotkey utilities for formatting and displaying keyboard shortcuts.
 * Supports both single keys and compound hotkeys (e.g., "CommandOrControl+Shift+K").
 */

/**
 * Detects if the current platform is macOS.
 */
function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|Darwin/.test(navigator.platform);
}

/**
 * Maps Electron accelerator parts to user-friendly labels.
 * Automatically adapts to the current platform (macOS vs Windows/Linux).
 */
function formatModifierPart(part: string, isMac: boolean): string {
  switch (part) {
    case "CommandOrControl":
      return isMac ? "Cmd" : "Ctrl";
    case "Command":
    case "Cmd":
      return "Cmd";
    case "Control":
    case "Ctrl":
      return "Ctrl";
    case "Alt":
      return isMac ? "Option" : "Alt";
    case "Option":
      return "Option";
    case "Shift":
      return "Shift";
    case "Super":
    case "Meta":
      return isMac ? "Cmd" : "Win";
    case "Mouse3":
    case "MButton":
      return "Mouse 3 (Middle)";
    case "Mouse4":
    case "XButton1":
      return "Mouse 4 (Back)";
    case "Mouse5":
    case "XButton2":
      return "Mouse 5 (Forward)";
    default:
      return part;
  }
}

/**
 * Formats an Electron accelerator string into a user-friendly display label.
 *
 * @param hotkey - The hotkey string in Electron accelerator format
 * @returns User-friendly label (e.g., "Cmd+Shift+K" on macOS, "Ctrl+Shift+K" on Windows)
 *
 * @example
 * formatHotkeyLabel("CommandOrControl+Shift+K") // "Cmd+Shift+K" on macOS, "Ctrl+Shift+K" on Windows
 * formatHotkeyLabel("GLOBE") // "Globe"
 * formatHotkeyLabel("`") // "`"
 * formatHotkeyLabel(null) // ""
 */
export function formatHotkeyLabel(hotkey?: string | null): string {
  // Handle empty/null values - return default backtick
  if (!hotkey || hotkey.trim() === "") {
    return "`";
  }

  // Handle special GLOBE key for macOS
  if (hotkey === "GLOBE") {
    return "Globe/Fn";
  }

  // Handle compound hotkeys (contains "+")
  if (hotkey.includes("+")) {
    const isMac = isMacPlatform();
    const parts = hotkey.split("+");

    const formattedParts = parts.map((part) => formatModifierPart(part, isMac));

    return formattedParts.join("+");
  }

  // Single key - format a few known non-keyboard inputs
  const isMac = isMacPlatform();
  return formatModifierPart(hotkey, isMac);
}

/**
 * Parses a hotkey string to extract modifiers and the base key.
 *
 * @param hotkey - The hotkey string in Electron accelerator format
 * @returns Object with modifiers array and baseKey
 *
 * @example
 * parseHotkey("CommandOrControl+Shift+K")
 * // { modifiers: ["CommandOrControl", "Shift"], baseKey: "K" }
 */
export function parseHotkey(hotkey: string): {
  modifiers: string[];
  baseKey: string;
} {
  if (!hotkey || !hotkey.includes("+")) {
    return { modifiers: [], baseKey: hotkey || "" };
  }

  const parts = hotkey.split("+");
  const baseKey = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);

  return { modifiers, baseKey };
}

/**
 * Checks if a hotkey is a compound hotkey (has modifiers).
 *
 * @param hotkey - The hotkey string
 * @returns True if the hotkey includes modifiers
 */
export function isCompoundHotkey(hotkey: string): boolean {
  return hotkey?.includes("+") || false;
}

/**
 * Gets the default hotkey for the current platform.
 * - macOS: GLOBE key (Fn key on modern Macs)
 * - Windows/Linux: Ctrl+Space
 */
export function getDefaultHotkey(): string {
  const isMac = isMacPlatform();
  return isMac ? "GLOBE" : "CommandOrControl+Space";
}

/**
 * The Read Aloud shortcut a fresh install gets.
 *
 * The reasoning behind this exact combination, and the survey of what else
 * binds nearby keys, lives above the matching constant in
 * `src/helpers/readAloudHotkey.js`. The two must stay equal: the renderer
 * stores this value and the main process registers it.
 */
export const DEFAULT_READ_ALOUD_HOTKEY = "Ctrl+Alt+Shift+R";

/**
 * The Read Aloud default that shipped before the survey above. Only used to
 * recognise an untouched old default during migration.
 */
export const LEGACY_READ_ALOUD_HOTKEY = "Ctrl+Alt+R";

/** Must equal DEFAULT_AGENT_MODE_HOTKEY in src/helpers/agentModeHotkey.js. */
export const DEFAULT_AGENT_MODE_HOTKEY = "RightControl";

/**
 * The keys the Agent Mode picker offers, value first, label second.
 *
 * No F11 or F12: browsers and editors keep those for full screen and dev tools.
 * No Left Ctrl or Left Alt: those sit under the hands that are typing.
 */
export const AGENT_MODE_HOTKEY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "RightControl", label: "Right Ctrl" },
  { value: "RightAlt", label: "Right Alt" },
  { value: "RightShift", label: "Right Shift" },
  { value: "Pause", label: "Pause" },
  { value: "ScrollLock", label: "Scroll Lock" },
  { value: "F8", label: "F8" },
  { value: "F9", label: "F9" },
  { value: "F10", label: "F10" },
];

/**
 * Modifier spellings that mean the same physical key, mapped to one token each.
 *
 * Electron accepts several names for the same modifier and this app writes more
 * than one of them: `mapKeyboardEventToHotkey` emits `CommandOrControl`, the
 * modifier-only combo path emits `Control`, and the Read Aloud default is
 * written `Ctrl`. Comparing two hotkeys as strings would call those different
 * keys and let two features quietly bind the same combination.
 */
const COMPARISON_MODIFIER_ALIASES: Record<string, string> = {
  commandorcontrol: "Ctrl",
  cmdorctrl: "Ctrl",
  control: "Ctrl",
  ctrl: "Ctrl",
  command: "Meta",
  cmd: "Meta",
  super: "Meta",
  meta: "Meta",
  win: "Meta",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};

/**
 * Canonical form of a hotkey, for deciding whether two of them are the same key.
 *
 * Modifier aliases collapse to one token, modifiers are sorted so order cannot
 * matter, and the base key is upper-cased. The result is only meant to be
 * compared against another result of this function — it is not a valid
 * accelerator and must never be registered or displayed.
 *
 * @example
 * normalizeHotkeyForComparison("CommandOrControl+Space") // "Ctrl+SPACE"
 * normalizeHotkeyForComparison("Ctrl+Space")             // "Ctrl+SPACE"
 */
export function normalizeHotkeyForComparison(hotkey?: string | null): string {
  const raw = (hotkey || "").trim();
  if (!raw) return "";
  if (raw === "GLOBE") return "GLOBE";

  const modifiers = new Set<string>();
  const baseKeys: string[] = [];

  for (const rawPart of raw.split("+")) {
    const part = rawPart.trim();
    if (!part) continue;
    const alias = COMPARISON_MODIFIER_ALIASES[part.toLowerCase()];
    if (alias) {
      modifiers.add(alias);
    } else {
      baseKeys.push(part.toUpperCase());
    }
  }

  return [...Array.from(modifiers).sort(), ...baseKeys].join("+");
}

/** True when the base key of a hotkey is Escape, under either spelling. */
function hasEscapeBaseKey(hotkey: string): boolean {
  const { baseKey } = parseHotkey(hotkey);
  const key = baseKey.trim().toLowerCase();
  return key === "esc" || key === "escape";
}

/**
 * Validates if a hotkey string is in a valid format.
 * Valid formats include single keys and Electron accelerator strings.
 *
 * @param hotkey - The hotkey string to validate
 * @returns True if the hotkey format is valid
 */
export function isValidHotkeyFormat(hotkey: string): boolean {
  if (!hotkey || hotkey.trim() === "") {
    return false;
  }

  // Special keys are always valid
  if (hotkey === "GLOBE") {
    return true;
  }

  // Escape is the one key the whole desktop agrees means "get me out of here".
  // Binding it globally takes that away from every other app, so it is not a
  // valid hotkey no matter how it got here.
  if (hasEscapeBaseKey(hotkey)) {
    return false;
  }

  // Single character or word keys are valid
  if (!hotkey.includes("+")) {
    return true;
  }

  // Compound hotkey: must have at least one modifier and one base key
  const parts = hotkey.split("+");
  if (parts.length < 2) {
    return false;
  }

  // Check that all parts are non-empty
  return parts.every((part) => part.trim().length > 0);
}

/** The hotkey values a settings store holds, as read from localStorage. */
export interface StoredHotkeySettings {
  dictationKey?: string | null;
  readAloudHotkey?: string | null;
}

/** The defaults each field falls back to when its stored value is unusable. */
export interface HotkeyMigrationDefaults {
  dictationKey: string;
  readAloudHotkey: string;
}

/**
 * Decides which stored hotkeys have to be rewritten, and to what.
 *
 * Two repairs, both of them one-way:
 *
 *  - Read Aloud's old default `Ctrl+Alt+R` becomes the new one. A user who
 *    deliberately picked `Ctrl+Alt+R` is indistinguishable from one who never
 *    touched the default, so they are moved too. That is accepted: the reason
 *    for the move (Firefox's Reader Mode, and AltGr being Ctrl+Alt on European
 *    layouts) applies to them just as much.
 *  - A hotkey stored as Escape is a victim of the capture bug this shipped
 *    with, where pressing Esc to back out of the field bound Esc instead. There
 *    is no chance it was wanted, so it goes back to the field's default.
 *
 * Pure and idempotent: running it on its own output returns no changes.
 *
 * @returns Only the fields that need writing. An empty object means nothing to do.
 */
export function migrateHotkeySettings(
  stored: StoredHotkeySettings,
  defaults: HotkeyMigrationDefaults
): Partial<HotkeyMigrationDefaults> {
  const changes: Partial<HotkeyMigrationDefaults> = {};

  const dictationKey = (stored.dictationKey || "").trim();
  if (dictationKey && hasEscapeBaseKey(dictationKey)) {
    changes.dictationKey = defaults.dictationKey;
  }

  const readAloudHotkey = (stored.readAloudHotkey || "").trim();
  if (readAloudHotkey && hasEscapeBaseKey(readAloudHotkey)) {
    changes.readAloudHotkey = defaults.readAloudHotkey;
  } else if (
    readAloudHotkey &&
    normalizeHotkeyForComparison(readAloudHotkey) ===
      normalizeHotkeyForComparison(LEGACY_READ_ALOUD_HOTKEY)
  ) {
    changes.readAloudHotkey = DEFAULT_READ_ALOUD_HOTKEY;
  }

  return changes;
}

/**
 * Apply `migrateHotkeySettings` to localStorage, once, at renderer startup.
 *
 * Runs before React mounts so `useSettings` reads the repaired values on its
 * first render rather than reading the old ones and overwriting the repair.
 */
export function applyStoredHotkeyMigrations(): Partial<HotkeyMigrationDefaults> {
  if (typeof localStorage === "undefined") return {};

  try {
    const changes = migrateHotkeySettings(
      {
        dictationKey: readStoredHotkey(localStorage.getItem("dictationKey")),
        readAloudHotkey: readStoredHotkey(localStorage.getItem("readAloudHotkey")),
      },
      {
        dictationKey: getDefaultHotkey(),
        readAloudHotkey: DEFAULT_READ_ALOUD_HOTKEY,
      }
    );

    for (const [key, value] of Object.entries(changes)) {
      localStorage.setItem(key, value);
    }
    return changes;
  } catch (error) {
    // A migration that cannot run must not stop the app from starting.
    console.error("[hotkeys] Could not migrate stored hotkeys:", error);
    return {};
  }
}

/**
 * Reads a hotkey value that was written to localStorage, tolerating a
 * JSON-quoted wrapper.
 *
 * Hotkey settings are stored raw, so `Mouse4` is the literal contents. An
 * earlier build wrote the voice-call mute key through the default JSON
 * serializer, which stored `"Mouse4"` with the quote characters included. The
 * settings screen read it back through the same serializer and looked correct,
 * while the dictation hook read localStorage directly and got a key name no
 * amount of parsing would match. Stripping the wrapper here repairs anyone who
 * saved a key before the serializer was fixed.
 */
export function readStoredHotkey(raw: string | null): string {
  const value = (raw || "").trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const unwrapped = JSON.parse(value);
      return typeof unwrapped === "string" ? unwrapped : "";
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}
