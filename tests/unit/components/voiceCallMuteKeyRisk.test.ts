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

  test("warns that modifiers stay pressed for the length of the dictation", () => {
    const risk = describeKeyRisk("CommandOrControl+Shift+M");
    expect(risk).toContain("held down");
    expect(risk).toContain("modifiers");
  });

  test("warns about mouse buttons firing navigation on release", () => {
    // Mouse4 and Mouse5 are back and forward. Releasing one at the end of a
    // dictation navigates whatever window happens to have focus.
    expect(describeKeyRisk("Mouse4")).toContain("back or forward");
    expect(describeKeyRisk("Mouse5")).toContain("back or forward");
  });

  test("a modifier plus a mouse button is still reported", () => {
    expect(describeKeyRisk("Shift+Mouse4")).not.toBeNull();
  });
});
