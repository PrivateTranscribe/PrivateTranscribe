import { describe, expect, test } from "vitest";
import { formatHotkeyLabel, readStoredHotkey } from "../../../src/utils/hotkeys";

/**
 * These assertions import the real formatter, unlike hotkeys.test.ts which
 * tests an inline copy of it. Mouse button labels have to stay correct in the
 * shipped code, because the voice-call mute setting asks the user to match a
 * button against the number their voice app shows.
 */
describe("formatHotkeyLabel mouse buttons (real implementation)", () => {
  test("uses the same numbering voice apps show in their keybind lists", () => {
    expect(formatHotkeyLabel("Mouse3")).toBe("Mouse 3 (Middle)");
    expect(formatHotkeyLabel("Mouse4")).toBe("Mouse 4 (Back)");
    expect(formatHotkeyLabel("Mouse5")).toBe("Mouse 5 (Forward)");
  });

  test("accepts the Win32 names for the same buttons", () => {
    expect(formatHotkeyLabel("MButton")).toBe("Mouse 3 (Middle)");
    expect(formatHotkeyLabel("XButton1")).toBe("Mouse 4 (Back)");
    expect(formatHotkeyLabel("XButton2")).toBe("Mouse 5 (Forward)");
  });
});

describe("readStoredHotkey", () => {
  test("returns a raw stored key unchanged", () => {
    expect(readStoredHotkey("Mouse4")).toBe("Mouse4");
    expect(readStoredHotkey("Ctrl+Shift+M")).toBe("Ctrl+Shift+M");
    expect(readStoredHotkey("`")).toBe("`");
  });

  test("unwraps a value written by the default JSON serializer", () => {
    // The settings screen deserialized this correctly while the dictation hook
    // read localStorage directly and got a key name with quote characters in
    // it, so the mute fired in the settings test and never during a dictation.
    expect(readStoredHotkey('"Mouse4"')).toBe("Mouse4");
    expect(readStoredHotkey('"Ctrl+Shift+M"')).toBe("Ctrl+Shift+M");
  });

  test("treats missing or empty values as no key", () => {
    expect(readStoredHotkey(null)).toBe("");
    expect(readStoredHotkey("")).toBe("");
    expect(readStoredHotkey('""')).toBe("");
  });
});
