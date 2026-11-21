import { describe, expect, it } from "vitest";
import { getHotkeyListenerNotice } from "../../../src/utils/hotkeyListenerNotice";

describe("getHotkeyListenerNotice", () => {
  it("tells the user to restart once the listener's own restarts are used up", () => {
    expect(getHotkeyListenerNotice({ reason: "error", kind: "crashed" })).toEqual({
      title: "Hotkey listener stopped",
      description:
        "It was restarted twice and stopped again. Restart PrivateTranscribe to get your hotkey back.",
    });
  });

  it("asks for another hotkey when the listener cannot watch this one", () => {
    expect(getHotkeyListenerNotice({ reason: "error", kind: "bad_hotkey" })?.title).toBe(
      "Hotkey not supported"
    );
  });

  it("does not claim restarts for a listener that never started", () => {
    const notice = getHotkeyListenerNotice({ reason: "error", kind: "failed_to_start" });
    expect(notice?.title).toBe("Hotkey listener could not start");
    expect(notice?.description).not.toMatch(/restarted twice/);
  });

  it("stays quiet for a developer build without the listener binary", () => {
    expect(getHotkeyListenerNotice({ reason: "binary_not_found" })).toBeNull();
    expect(getHotkeyListenerNotice(null)).toBeNull();
  });
});
