import { describe, it, expect } from "vitest";
import { mapKeyboardEventToHotkey } from "../../../src/components/ui/HotkeyInput";

describe("HotkeyInput keyboard mapping", () => {
  it("maps normal compound hotkeys consistently", () => {
    const hotkey = mapKeyboardEventToHotkey({
      code: "Space",
      key: " ",
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    } as KeyboardEvent);

    expect(hotkey).toBe("CommandOrControl+Space");
  });

  it("captures locale-specific printable glyph keys", () => {
    const hotkey = mapKeyboardEventToHotkey({
      code: "Backquote",
      key: "½",
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    } as KeyboardEvent);

    expect(hotkey).toBe("½");
  });
});
