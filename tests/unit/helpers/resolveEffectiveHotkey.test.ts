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

  test("adopts the captured hotkey only when one was reported", () => {
    expect(resolveEffectiveHotkey(false, "F9", "`")).toBe("F9");
  });

  test("keeps the existing hotkey while capture mode is being entered", () => {
    // Entering capture must never adopt a key, whatever is passed alongside it.
    expect(resolveEffectiveHotkey(true, "Mouse4", "`")).toBe("`");
  });
});
