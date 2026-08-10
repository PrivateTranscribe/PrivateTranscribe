import { describe, expect, test } from "vitest";
import { describeKeyRisk } from "../../../src/components/ui/VoiceCallMuteSettings";

/**
 * The mute key is held for the whole dictation rather than tapped, so the
 * question "is this a good key" has a different answer here than it does for an
 * ordinary shortcut. These cases pin down the distinction.
 */
describe("describeKeyRisk", () => {
  test("a bare inert key draws no warning", () => {
    expect(describeKeyRisk("Pause")).toBeNull();
    expect(describeKeyRisk("F13")).toBeNull();
    expect(describeKeyRisk("Scrolllock")).toBeNull();
  });

  test("no warning before a key has been chosen", () => {
    expect(describeKeyRisk("")).toBeNull();
  });

  test("Ctrl and Shift are usable, with the collision to check for", () => {
    // Observed in Discord: a bare Pause keybind also fires on Ctrl+Shift+Pause,
    // so the push-to-mute and the toggle both trigger and cancel each other
    // out. The base key is the thing to check, so the note names it.
    const risk = describeKeyRisk("CommandOrControl+Shift+Pause");
    expect(risk).toContain("base key");
    expect(risk).toContain("both keybinds");
  });

  test("Alt and the Windows key are called out separately", () => {
    // These are the modifiers that do something on release, which is exactly
    // what happens at the end of every dictation.
    for (const key of ["Alt+M", "CommandOrControl+Alt+M", "Super+M"]) {
      expect(describeKeyRisk(key)).toContain("on release");
    }
  });

  test("warns about mouse buttons firing navigation on release", () => {
    // Mouse4 and Mouse5 are back and forward. Releasing one at the end of a
    // dictation navigates whatever window happens to have focus.
    expect(describeKeyRisk("Mouse4")).toContain("back or forward");
    expect(describeKeyRisk("Mouse5")).toContain("back or forward");
  });

  test("a modifier plus a mouse button reports the mouse problem", () => {
    // The more serious of the two, so it wins over the generic modifier note.
    expect(describeKeyRisk("Shift+Mouse4")).toContain("back or forward");
  });
});
