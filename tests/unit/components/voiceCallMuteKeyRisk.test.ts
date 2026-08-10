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

  test("Ctrl and Shift are flagged but not condemned", () => {
    // These are usable. The note says what the real exposure is — mousing
    // mid-dictation — and reassures that the text itself is safe, because the
    // key is released before anything is pasted.
    const risk = describeKeyRisk("CommandOrControl+Shift+M");
    expect(risk).toContain("clicking or scrolling");
    expect(risk).toContain("text is unaffected");
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
