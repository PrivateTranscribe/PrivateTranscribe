import React, { useState, useCallback, useRef, useEffect } from "react";
import { formatHotkeyLabel, normalizeHotkeyForComparison } from "../../utils/hotkeys";

const CODE_TO_KEY: Record<string, string> = {
  Backquote: "`",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
  Digit0: "0",
  Minus: "-",
  Equal: "=",
  // QWERTY row
  KeyQ: "Q",
  KeyW: "W",
  KeyE: "E",
  KeyR: "R",
  KeyT: "T",
  KeyY: "Y",
  KeyU: "U",
  KeyI: "I",
  KeyO: "O",
  KeyP: "P",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  // ASDF row
  KeyA: "A",
  KeyS: "S",
  KeyD: "D",
  KeyF: "F",
  KeyG: "G",
  KeyH: "H",
  KeyJ: "J",
  KeyK: "K",
  KeyL: "L",
  Semicolon: ";",
  Quote: "'",
  // ZXCV row
  KeyZ: "Z",
  KeyX: "X",
  KeyC: "C",
  KeyV: "V",
  KeyB: "B",
  KeyN: "N",
  KeyM: "M",
  Comma: ",",
  Period: ".",
  Slash: "/",
  // Special keys.
  // Escape, Backspace and Delete are deliberately absent — see
  // NON_CAPTURABLE_CODES. They drive the field instead of being captured by it.
  Space: "Space",
  Tab: "Tab",
  Enter: "Enter",
  // Function keys
  F1: "F1",
  F2: "F2",
  F3: "F3",
  F4: "F4",
  F5: "F5",
  F6: "F6",
  F7: "F7",
  F8: "F8",
  F9: "F9",
  F10: "F10",
  F11: "F11",
  F12: "F12",
  // Extended function keys (F13-F24)
  F13: "F13",
  F14: "F14",
  F15: "F15",
  F16: "F16",
  F17: "F17",
  F18: "F18",
  F19: "F19",
  F20: "F20",
  F21: "F21",
  F22: "F22",
  F23: "F23",
  F24: "F24",
  // Arrow keys
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  // Navigation keys
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  // Additional keys (useful on Windows/Linux)
  Pause: "Pause",
  ScrollLock: "Scrolllock",
  PrintScreen: "PrintScreen",
  NumLock: "Numlock",
  // Numpad keys
  Numpad0: "num0",
  Numpad1: "num1",
  Numpad2: "num2",
  Numpad3: "num3",
  Numpad4: "num4",
  Numpad5: "num5",
  Numpad6: "num6",
  Numpad7: "num7",
  Numpad8: "num8",
  Numpad9: "num9",
  NumpadAdd: "numadd",
  NumpadSubtract: "numsub",
  NumpadMultiply: "nummult",
  NumpadDivide: "numdiv",
  NumpadDecimal: "numdec",
  NumpadEnter: "Enter",
  // Media keys (may work on some systems)
  MediaPlayPause: "MediaPlayPause",
  MediaStop: "MediaStop",
  MediaTrackNext: "MediaNextTrack",
  MediaTrackPrevious: "MediaPreviousTrack",
};

const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "CapsLock",
]);

/**
 * Keys that operate the field rather than being recorded by it.
 *
 * Escape is the desktop's universal "back out of this", and it used to be
 * capturable here: pressing it to abandon the field bound Escape as the global
 * dictation hotkey, taking the key away from every other app on the machine.
 * Backspace and Delete are what anyone reaches for to empty a field, so
 * recording them as a shortcut is the opposite of what was meant. All three are
 * also absent from CODE_TO_KEY, so nothing downstream can commit them either.
 */
const NON_CAPTURABLE_CODES = {
  cancel: new Set(["Escape"]),
  clear: new Set(["Backspace", "Delete"]),
};

/** Another feature's hotkey, and the name to show if the user picks it too. */
export interface HotkeyConflict {
  /** The feature's visible name, e.g. "Read Aloud". */
  label: string;
  /** That feature's current hotkey. Empty or unset entries are ignored. */
  hotkey: string;
}

export interface HotkeyInputProps {
  value: string;
  onChange: (hotkey: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
  /**
   * Other hotkeys in this app that the captured key must not collide with.
   *
   * Two features answering the same key press is not something the OS reports —
   * one registration silently wins — so the refusal has to happen here, before
   * the value is committed.
   */
  conflicts?: HotkeyConflict[];
  /**
   * Reset this field to its default. When provided, Backspace and Delete call
   * it; without it they behave like Escape and cancel.
   */
  onClear?: () => void;
  /** Names the field for screen readers, e.g. "Dictation hotkey". */
  ariaLabel?: string;
  /**
   * Whether the captured key becomes the global dictation hotkey.
   *
   * Capture mode always unregisters the dictation hotkey so pressing a key here
   * cannot start a dictation. On exit the main process re-registers it, and it
   * adopts whatever key this field reports. That is right for the dictation
   * hotkey field and wrong for every other use: capturing a mute key would
   * otherwise repoint the dictation listener at it, leaving the user unable to
   * start dictating at all. Pass false to restore the existing hotkey instead.
   */
  appliesToDictationHotkey?: boolean;
  /** Reset through the same validation as a recorded shortcut. */
  resetHotkey?: string;
}

// eslint-disable-next-line react-refresh/only-export-components
export function mapKeyboardEventToHotkey(e: KeyboardEvent): string | null {
  if (MODIFIER_CODES.has(e.code)) {
    return null;
  }

  if (NON_CAPTURABLE_CODES.cancel.has(e.code) || NON_CAPTURABLE_CODES.clear.has(e.code)) {
    return null;
  }

  const baseKey = CODE_TO_KEY[e.code];
  if (!baseKey) {
    return null;
  }

  const modifiers: string[] = [];

  if (e.ctrlKey || e.metaKey) {
    modifiers.push("CommandOrControl");
  }
  if (e.altKey) {
    modifiers.push("Alt");
  }
  if (e.shiftKey) {
    modifiers.push("Shift");
  }

  return modifiers.length > 0 ? [...modifiers, baseKey].join("+") : baseKey;
}

// eslint-disable-next-line react-refresh/only-export-components
export function mapMouseEventToHotkey(e: MouseEvent): string | null {
  // Browser MouseEvent.button mapping:
  // 0=Left, 1=Middle, 2=Right, 3=Back, 4=Forward
  //
  // Middle and the two side buttons are capturable. Left and right are not,
  // because binding them would make the rest of the interface unusable.
  // The Mouse3/4/5 names match the numbering Discord shows in its own keybind
  // list, so a user setting the same physical button in both apps sees the same
  // label in both places.
  let baseKey: string | null = null;
  if (e.button === 1) baseKey = "Mouse3";
  if (e.button === 3) baseKey = "Mouse4";
  if (e.button === 4) baseKey = "Mouse5";
  if (!baseKey) return null;

  const modifiers: string[] = [];
  if (e.ctrlKey || e.metaKey) modifiers.push("CommandOrControl");
  if (e.altKey) modifiers.push("Alt");
  if (e.shiftKey) modifiers.push("Shift");

  return modifiers.length > 0 ? [...modifiers, baseKey].join("+") : baseKey;
}

export interface HotkeyInputVariant {
  variant?: "default" | "hero";
}

export function HotkeyInput({
  value,
  onChange,
  onBlur,
  disabled = false,
  autoFocus = false,
  conflicts,
  onClear,
  ariaLabel,
  appliesToDictationHotkey = true,
  resetHotkey,
  variant = "default",
}: HotkeyInputProps & HotkeyInputVariant) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [activeModifiers, setActiveModifiers] = useState<Set<string>>(new Set());
  /** The feature that already owns the key just pressed, while it is refused. */
  const [conflictLabel, setConflictLabel] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastCapturedHotkeyRef = useRef<string | null>(null);
  // Held in a ref so the mouse listener below does not resubscribe on every
  // render just because the caller passed a fresh array literal.
  const conflictsRef = useRef<HotkeyConflict[] | undefined>(conflicts);
  conflictsRef.current = conflicts;
  const isMac = typeof navigator !== "undefined" && /Mac|Darwin/.test(navigator.platform);
  const isWindows = typeof navigator !== "undefined" && /Win/.test(navigator.platform);

  // Track held modifier state for modifier-only combo capture (e.g. Ctrl+Win)
  const heldModifiersRef = useRef({ ctrl: false, meta: false, alt: false, shift: false });
  const keyDownTimeRef = useRef(0);
  // How long a modifier combo must be held to register (avoids accidental captures)
  const MODIFIER_HOLD_THRESHOLD_MS = 300;

  /** Forget everything about the press in progress. */
  const resetPressState = useCallback(() => {
    setActiveModifiers(new Set());
    heldModifiersRef.current = { ctrl: false, meta: false, alt: false, shift: false };
    keyDownTimeRef.current = 0;
  }, []);

  /**
   * Leave capture without reporting a hotkey.
   *
   * lastCapturedHotkeyRef stays null on purpose: the blur handler hands it to
   * the main process, and null is what tells it to put back the hotkey the app
   * already had. Anything else would make backing out of the field change the
   * very setting the user was backing out of.
   */
  const cancelCapture = useCallback(() => {
    lastCapturedHotkeyRef.current = null;
    setIsCapturing(false);
    setConflictLabel(null);
    resetPressState();
    containerRef.current?.blur();
  }, [resetPressState]);

  /**
   * Report a captured hotkey, unless another feature already owns it.
   *
   * A refusal keeps the field listening so the next press is the correction,
   * rather than dropping the user out of capture with nothing changed and no
   * explanation.
   */
  const commitCapture = useCallback(
    (hotkey: string) => {
      if (!appliesToDictationHotkey) {
        const parts = hotkey.split("+");
        if (
          parts.some((key) => /^(GLOBE|Mouse[345])$/.test(key)) ||
          parts.every((key) =>
            /^(CommandOrControl|Control|Ctrl|Alt|Shift|Super|Meta|Command)$/.test(key)
          )
        ) {
          setConflictLabel("Use a keyboard key, with optional modifiers");
          resetPressState();
          return false;
        }
      }
      const normalized = normalizeHotkeyForComparison(hotkey);
      const conflict = (conflictsRef.current || []).find(
        (entry) => entry.hotkey && normalizeHotkeyForComparison(entry.hotkey) === normalized
      );

      if (conflict) {
        setConflictLabel(`Already used by ${conflict.label}`);
        resetPressState();
        return false;
      }

      lastCapturedHotkeyRef.current = hotkey;
      onChange(hotkey);
      setIsCapturing(false);
      setConflictLabel(null);
      resetPressState();
      containerRef.current?.blur();
      return true;
    },
    [onChange, resetPressState, appliesToDictationHotkey]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      e.preventDefault();
      e.stopPropagation();

      if (NON_CAPTURABLE_CODES.cancel.has(e.nativeEvent.code)) {
        cancelCapture();
        return;
      }

      if (NON_CAPTURABLE_CODES.clear.has(e.nativeEvent.code)) {
        // Without an onClear there is nothing sensible to reset to, so this
        // degrades to the same "leave it alone" behaviour as Escape.
        if (resetHotkey) {
          commitCapture(resetHotkey);
          return;
        }
        onClear?.();
        cancelCapture();
        return;
      }

      // A refusal is about the key that caused it; the next press supersedes it.
      setConflictLabel(null);

      // Track held modifiers for modifier-only combo capture
      heldModifiersRef.current = {
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        alt: e.altKey,
        shift: e.shiftKey,
      };
      if (keyDownTimeRef.current === 0) {
        keyDownTimeRef.current = Date.now();
      }

      const mods = new Set<string>();
      if (e.ctrlKey) mods.add("Ctrl");
      if (e.metaKey) mods.add(isWindows ? "Win" : isMac ? "Cmd" : "Super");
      if (e.altKey) mods.add(isMac ? "Option" : "Alt");
      if (e.shiftKey) mods.add("Shift");
      setActiveModifiers(mods);

      const hotkey = mapKeyboardEventToHotkey(e.nativeEvent);
      if (hotkey) {
        commitCapture(hotkey);
      }
      // If no base key yet, modifiers are being held - don't finalize until keyup
    },
    [disabled, isMac, isWindows, commitCapture, cancelCapture, onClear, resetHotkey]
  );

  const handleKeyUp = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      e.preventDefault();

      const wasHoldingModifiers =
        heldModifiersRef.current.ctrl ||
        heldModifiersRef.current.meta ||
        heldModifiersRef.current.alt ||
        heldModifiersRef.current.shift;

      // Attempt modifier-only combo capture on keyup of a modifier key
      if (wasHoldingModifiers && MODIFIER_CODES.has(e.nativeEvent.code)) {
        const holdDuration = Date.now() - keyDownTimeRef.current;
        if (holdDuration >= MODIFIER_HOLD_THRESHOLD_MS) {
          // Build combo from held modifiers
          const parts: string[] = [];
          if (heldModifiersRef.current.ctrl) parts.push("Control");
          if (heldModifiersRef.current.meta) parts.push(isMac ? "Command" : "Super");
          if (heldModifiersRef.current.alt) parts.push(isMac ? "Alt" : "Alt");
          if (heldModifiersRef.current.shift) parts.push("Shift");
          // Require 2+ modifiers for modifier-only combos (e.g. Ctrl+Win)
          if (parts.length >= 2) {
            commitCapture(parts.join("+"));
            return;
          }
        }
      }

      resetPressState();
    },
    [disabled, isMac, commitCapture, resetPressState]
  );

  const handleFocus = useCallback(() => {
    if (!disabled) {
      setIsCapturing(true);
      window.electronAPI?.setHotkeyListeningMode?.(true);
    }
  }, [disabled]);

  const handleBlur = useCallback(() => {
    setIsCapturing(false);
    setActiveModifiers(new Set());
    setConflictLabel(null);
    // Passing null makes the main process restore the hotkey it already had.
    // Only the dictation hotkey field may hand over the key it just captured.
    window.electronAPI?.setHotkeyListeningMode?.(
      false,
      appliesToDictationHotkey ? lastCapturedHotkeyRef.current : null
    );
    lastCapturedHotkeyRef.current = null;
    onBlur?.();
  }, [onBlur, appliesToDictationHotkey]);

  useEffect(() => {
    if (autoFocus && containerRef.current) {
      containerRef.current.focus();
    }
  }, [autoFocus]);

  useEffect(() => {
    return () => {
      window.electronAPI?.setHotkeyListeningMode?.(false, null);
    };
  }, []);

  useEffect(() => {
    if (!isCapturing) return;

    // Allow capturing the middle and side mouse buttons (Mouse3/Mouse4/Mouse5)
    // while the input is "listening". Voice apps commonly bind push-to-talk and
    // push-to-mute to these, so a keyboard-only field could not express what the
    // user already has set up.
    // Important: preventDefault to avoid browser back/forward navigation and
    // middle-click autoscroll.
    const onMouseDown = (e: MouseEvent) => {
      if (disabled) return;
      const hotkey = mapMouseEventToHotkey(e);
      if (!hotkey) return;

      e.preventDefault();
      e.stopPropagation();

      const mods = new Set<string>();
      if (e.ctrlKey || e.metaKey) mods.add(isMac ? "Cmd" : "Ctrl");
      if (e.altKey) mods.add(isMac ? "Option" : "Alt");
      if (e.shiftKey) mods.add("Shift");
      setActiveModifiers(mods);

      commitCapture(hotkey);
    };

    window.addEventListener("mousedown", onMouseDown, true);

    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
    };
  }, [isCapturing, disabled, isMac, commitCapture]);

  useEffect(() => {
    if (!isCapturing || !isMac) return;

    const dispose = window.electronAPI?.onGlobeKeyPressed?.(() => {
      commitCapture("GLOBE");
    });

    return () => dispose?.();
  }, [isCapturing, isMac, commitCapture]);

  const displayValue = formatHotkeyLabel(value);
  const isGlobe = value === "GLOBE";
  const hotkeyParts = value?.includes("+") ? displayValue.split("+") : [];
  const fieldLabel = ariaLabel || "Press a key combination to set hotkey";

  // The two ways out of capture are not discoverable from a field that only
  // says "Recording", so they are stated while it is listening.
  const captureHint = onClear || resetHotkey ? "Esc cancels · Backspace resets" : "Esc cancels";

  const conflictNotice = conflictLabel ? (
    <span
      role="status"
      data-testid="hotkey-conflict"
      className="text-xs font-medium text-destructive"
    >
      {conflictLabel}
    </span>
  ) : null;

  // Hero variant: large centered key display for onboarding
  if (variant === "hero") {
    return (
      <div
        ref={containerRef}
        tabIndex={disabled ? -1 : 0}
        role="button"
        aria-label={fieldLabel}
        aria-disabled={disabled || undefined}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onFocus={handleFocus}
        onBlur={handleBlur}
        className={`
          relative group flex flex-col items-center justify-center py-5 px-6
          rounded-lg border cursor-pointer select-none outline-none
          transition-all duration-200
          ${
            disabled
              ? "bg-muted/30 border-border cursor-not-allowed opacity-50"
              : isCapturing
                ? "bg-primary/5 border-primary/40"
                : "bg-surface-1 border-border-subtle hover:border-border-hover hover:bg-surface-2"
          }
        `}
      >
        {/* Recording state */}
        {isCapturing ? (
          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-primary rounded-full animate-pulse" />
              <span className="text-xs font-medium text-primary">Listening...</span>
            </div>
            {activeModifiers.size > 0 ? (
              <div className="flex items-center gap-1.5">
                {Array.from(activeModifiers).map((mod) => (
                  <kbd
                    key={mod}
                    className="px-3 py-1.5 bg-primary/10 border border-primary/20 rounded text-sm font-semibold text-primary"
                  >
                    {mod}
                  </kbd>
                ))}
                <span className="text-primary/50 text-sm font-medium">+</span>
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">
                {isMac ? "Press any key or ⌘⇧K" : "Press any key or Ctrl+Shift+K"}
              </span>
            )}
            {conflictNotice}
            <span className="text-[10px] text-muted-foreground/60">{captureHint}</span>
          </div>
        ) : value ? (
          /* Has value: show the hotkey prominently */
          <div className="flex flex-col items-center gap-2">
            <div className="flex items-center gap-1.5">
              {hotkeyParts.length > 0 ? (
                hotkeyParts.map((part, i) => (
                  <React.Fragment key={part}>
                    {i > 0 && (
                      <span className="text-muted-foreground/40 text-lg font-light">+</span>
                    )}
                    <kbd className="px-3.5 py-2 bg-surface-raised border border-border-subtle rounded text-base font-semibold text-foreground shadow-sm">
                      {part}
                    </kbd>
                  </React.Fragment>
                ))
              ) : isGlobe ? (
                <kbd className="px-4 py-2 bg-surface-raised border border-border-subtle rounded text-xl shadow-sm">
                  🌐
                </kbd>
              ) : (
                <kbd className="px-4 py-2 bg-surface-raised border border-border-subtle rounded text-base font-bold text-foreground shadow-sm">
                  {displayValue}
                </kbd>
              )}
            </div>
            <span className="text-[10px] text-muted-foreground/60 group-hover:text-muted-foreground transition-colors">
              Click to change
            </span>
          </div>
        ) : (
          /* Empty state */
          <div className="flex flex-col items-center gap-1.5 text-muted-foreground">
            <span className="text-sm font-medium">Click to set hotkey</span>
          </div>
        )}
      </div>
    );
  }

  // Default variant: compact inline display
  return (
    <div
      ref={containerRef}
      tabIndex={disabled ? -1 : 0}
      role="button"
      aria-label={fieldLabel}
      aria-disabled={disabled || undefined}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onFocus={handleFocus}
      onBlur={handleBlur}
      className={`
        relative overflow-hidden rounded-lg border
        transition-all duration-200 cursor-pointer select-none focus:outline-none
        ${
          disabled
            ? "bg-muted/30 border-border cursor-not-allowed opacity-50"
            : isCapturing
              ? "bg-primary/5 border-primary/40 shadow-[0_0_0_2px_rgba(112,255,186,0.15)]"
              : "bg-surface-1 border-border-subtle hover:border-border-hover hover:bg-surface-2"
        }
      `}
    >
      {isCapturing && (
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-primary animate-pulse" />
      )}

      <div className="px-4 py-3">
        {isCapturing ? (
          <div className="flex flex-col items-center gap-1.5">
            <div className="flex items-center justify-center gap-3">
              <div className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" />
                <span className="text-xs font-medium text-muted-foreground">Recording</span>
              </div>
              {activeModifiers.size > 0 ? (
                <div className="flex items-center gap-1">
                  {Array.from(activeModifiers).map((mod) => (
                    <kbd
                      key={mod}
                      className="px-2 py-1 bg-primary/15 border border-primary/30 rounded text-xs font-semibold text-primary"
                    >
                      {mod}
                    </kbd>
                  ))}
                  <span className="text-primary/40 text-xs">+ key</span>
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {isMac ? "Try ⌘⇧K" : "Try Ctrl+Shift+K"}
                </span>
              )}
            </div>
            {conflictNotice}
            <span className="text-[10px] text-muted-foreground/60">{captureHint}</span>
          </div>
        ) : value ? (
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Hotkey</span>
            <div className="flex items-center gap-2">
              {hotkeyParts.length > 0 ? (
                <div className="flex items-center gap-1">
                  {hotkeyParts.map((part, i) => (
                    <React.Fragment key={part}>
                      {i > 0 && <span className="text-muted-foreground/30 text-xs">+</span>}
                      <kbd className="px-2 py-1 bg-surface-raised border border-border-subtle rounded text-sm font-semibold text-foreground">
                        {part}
                      </kbd>
                    </React.Fragment>
                  ))}
                </div>
              ) : isGlobe ? (
                <div className="flex items-center gap-1.5">
                  <kbd className="px-2 py-1 bg-surface-raised border border-border-subtle rounded text-lg">
                    🌐
                  </kbd>
                  <span className="text-xs text-muted-foreground">Globe</span>
                </div>
              ) : (
                <kbd className="px-3 py-1.5 bg-surface-raised border border-border-subtle rounded text-sm font-bold text-foreground">
                  {displayValue}
                </kbd>
              )}
              <span className="text-[10px] text-muted-foreground/60">click to change</span>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center gap-2 text-muted-foreground">
            <span className="text-sm font-medium">Click to set hotkey</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default HotkeyInput;
