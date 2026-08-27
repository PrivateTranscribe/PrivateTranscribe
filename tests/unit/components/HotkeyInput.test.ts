/**
 * Tests for the pure key-mapping helper behind HotkeyInput.
 *
 * The component itself needs a DOM to test; this function does not, and it is
 * the one place that decides whether a key press becomes a hotkey at all. The
 * cases below are the keys that must NEVER become one — Escape used to, and a
 * user who pressed it to back out of the field ended up binding the machine's
 * cancel key to dictation.
 *
 * @module tests/unit/components/HotkeyInput
 */

import { describe, it, expect } from "vitest";
import { mapKeyboardEventToHotkey } from "../../../src/components/ui/HotkeyInput";

/** Only the fields mapKeyboardEventToHotkey reads. */
function keyEvent(
  code: string,
  modifiers: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}
): KeyboardEvent {
  return {
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...modifiers,
  } as KeyboardEvent;
}

describe("mapKeyboardEventToHotkey", () => {
  describe("keys that drive the field instead of being captured", () => {
    it("returns null for Escape", () => {
      expect(mapKeyboardEventToHotkey(keyEvent("Escape"))).toBeNull();
      // Modifiers must not smuggle it through either.
      expect(mapKeyboardEventToHotkey(keyEvent("Escape", { ctrlKey: true }))).toBeNull();
      expect(
        mapKeyboardEventToHotkey(keyEvent("Escape", { ctrlKey: true, altKey: true }))
      ).toBeNull();
    });

    it("returns null for Backspace", () => {
      expect(mapKeyboardEventToHotkey(keyEvent("Backspace"))).toBeNull();
      expect(mapKeyboardEventToHotkey(keyEvent("Backspace", { shiftKey: true }))).toBeNull();
    });

    it("returns null for Delete", () => {
      expect(mapKeyboardEventToHotkey(keyEvent("Delete"))).toBeNull();
      expect(mapKeyboardEventToHotkey(keyEvent("Delete", { ctrlKey: true }))).toBeNull();
    });
  });

  describe("modifiers alone", () => {
    it("returns null while only modifiers are held", () => {
      expect(mapKeyboardEventToHotkey(keyEvent("ControlLeft", { ctrlKey: true }))).toBeNull();
      expect(mapKeyboardEventToHotkey(keyEvent("ShiftRight", { shiftKey: true }))).toBeNull();
      expect(mapKeyboardEventToHotkey(keyEvent("MetaLeft", { metaKey: true }))).toBeNull();
    });
  });

  describe("ordinary keys still map", () => {
    it("maps a bare key", () => {
      expect(mapKeyboardEventToHotkey(keyEvent("KeyK"))).toBe("K");
      expect(mapKeyboardEventToHotkey(keyEvent("Space"))).toBe("Space");
      expect(mapKeyboardEventToHotkey(keyEvent("F9"))).toBe("F9");
    });

    it("maps a key with modifiers", () => {
      expect(mapKeyboardEventToHotkey(keyEvent("KeyR", { ctrlKey: true, altKey: true }))).toBe(
        "CommandOrControl+Alt+R"
      );
      expect(
        mapKeyboardEventToHotkey(keyEvent("KeyR", { ctrlKey: true, altKey: true, shiftKey: true }))
      ).toBe("CommandOrControl+Alt+Shift+R");
    });

    it("returns null for a code it has no name for", () => {
      expect(mapKeyboardEventToHotkey(keyEvent("Lang1"))).toBeNull();
    });
  });
});
