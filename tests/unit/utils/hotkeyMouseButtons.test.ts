import { describe, expect, test } from "vitest";
import { formatHotkeyLabel } from "../../../src/utils/hotkeys";

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
