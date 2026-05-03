import { describe, expect, it } from "vitest";
import { mapKeyboardEventToHotkey, mapMouseEventToHotkey } from "../../../src/components/ui/HotkeyInput";

function keyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    code: "KeyA",
    key: "a",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  } as KeyboardEvent;
}

function mouseEvent(overrides: Partial<MouseEvent>): MouseEvent {
  return {
    button: 0,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  } as MouseEvent;
}

describe("HotkeyInput mapping", () => {
  it("preserves locale-specific printable keys like Danish ½", () => {
    expect(mapKeyboardEventToHotkey(keyEvent({ code: "Backquote", key: "½" }))).toBe("½");
  });

  it("keeps ASCII physical key mapping so shifted digits remain stable", () => {
    expect(mapKeyboardEventToHotkey(keyEvent({ code: "Digit1", key: "!", shiftKey: true }))).toBe(
      "Shift+1"
    );
  });

  it("captures mouse side buttons with modifiers", () => {
    expect(mapMouseEventToHotkey(mouseEvent({ button: 3, ctrlKey: true }))).toBe(
      "CommandOrControl+Mouse4"
    );
    expect(mapMouseEventToHotkey(mouseEvent({ button: 4 }))).toBe("Mouse5");
  });
});
