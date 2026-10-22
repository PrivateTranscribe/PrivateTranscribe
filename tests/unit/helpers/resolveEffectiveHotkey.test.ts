import { describe, expect, test } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveEffectiveHotkey } = require("../../../src/helpers/ipcHandlers");

/**
 * Regression cover for a bug where capturing a key in one settings field
 * repointed the global dictation hotkey at it.
 *
 * HotkeyInput unregisters the dictation hotkey while capturing so a keypress
 * cannot start a dictation, then reports a key on blur which the main process
 * re-registers. Reusing that component for the voice-call mute key meant
 * capturing "Mouse4" registered Mouse4 as the dictation hotkey, and dictation
 * stopped responding entirely.
 *
 * Fields that are not the dictation hotkey now pass null, which must mean
 * "restore the hotkey that was already there".
 */
describe("resolveEffectiveHotkey", () => {
  test("keeps the existing hotkey when the field reports null", () => {
    expect(resolveEffectiveHotkey(false, null, "`")).toBe("`");
    expect(resolveEffectiveHotkey(false, undefined, "F8")).toBe("F8");
    expect(resolveEffectiveHotkey(false, "", "F8")).toBe("F8");
  });

  test("adopts the captured hotkey once update-hotkey accepted it", () => {
    // update-hotkey runs first and makes an accepted key the current one.
    expect(resolveEffectiveHotkey(false, "F9", "F9")).toBe("F9");
  });

  test("keeps the hotkey the app has when update-hotkey refused the captured one", () => {
    // "-" is refused as unsupported, F9 when another app holds it. Wiring the
    // refused key made "-" untypeable in every app and left the old key dead.
    expect(resolveEffectiveHotkey(false, "-", "CommandOrControl+Space")).toBe(
      "CommandOrControl+Space"
    );
    expect(resolveEffectiveHotkey(false, "F9", "`")).toBe("`");
    expect(resolveEffectiveHotkey(false, "Mouse3", "`")).toBe("`");
  });

  test("takes the captured hotkey on GNOME, which confirms it only later", () => {
    expect(resolveEffectiveHotkey(false, "F9", "`", true)).toBe("F9");
  });

  test("keeps the existing hotkey while capture mode is being entered", () => {
    // Entering capture must never adopt a key, whatever is passed alongside it.
    expect(resolveEffectiveHotkey(true, "Mouse4", "`")).toBe("`");
  });
});
