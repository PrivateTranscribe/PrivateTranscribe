import { describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  app: {},
  clipboard: {
    readHTML: vi.fn(() => ""),
    readImage: vi.fn(() => ({ isEmpty: () => true })),
    readRTF: vi.fn(() => ""),
    readText: vi.fn(() => ""),
    write: vi.fn(),
    writeText: vi.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ClipboardManager = require("../../../src/helpers/clipboard");

const HELPER_PATH = "C:\\app\\resources\\bin\\windows-fast-paste.exe";

describe("ClipboardManager Windows paste routing", () => {
  test("the legacy nircmd and PowerShell paste paths no longer exist", () => {
    // Commit ff275a1 stopped routing to these after a failed helper paste, because an
    // unconfirmed second attempt could report success when nothing was pasted. Keeping
    // the methods around invited a future caller to reintroduce that bug, so they are
    // gone entirely. This test fails if either one comes back.
    const manager = new ClipboardManager();
    expect(manager.pasteWithNircmd).toBeUndefined();
    expect(manager.pasteWithPowerShell).toBeUndefined();
  });

  test("uses the native fast paste helper when it is available", async () => {
    const manager = new ClipboardManager();
    vi.spyOn(manager, "getFastPastePath").mockReturnValue(HELPER_PATH);
    const fastPaste = vi.spyOn(manager, "pasteWithFastPaste").mockResolvedValue(undefined);

    await manager.pasteWindows({ text: "before" });

    expect(fastPaste).toHaveBeenCalledWith(HELPER_PATH, { text: "before" }, {});
  });

  test("passes the send-enter request through to the helper", async () => {
    const manager = new ClipboardManager();
    vi.spyOn(manager, "getFastPastePath").mockReturnValue(HELPER_PATH);
    const fastPaste = vi.spyOn(manager, "pasteWithFastPaste").mockResolvedValue(undefined);

    await manager.pasteWindows({ text: "before" }, { sendEnter: true });

    expect(fastPaste).toHaveBeenCalledWith(HELPER_PATH, { text: "before" }, { sendEnter: true });
  });

  test("only hands the helper --send-enter when asked to send", () => {
    const manager = new ClipboardManager();
    const spawned = vi
      .spyOn(manager, "_spawnFastPaste")
      .mockImplementation(() => ({ on() {}, stdout: null, stderr: null }) as never);
    vi.useFakeTimers();
    try {
      void manager.pasteWithFastPaste(HELPER_PATH, { text: "before" }, { sendEnter: true });
      void manager.pasteWithFastPaste(HELPER_PATH, { text: "before" });
      vi.advanceTimersByTime(50);
    } finally {
      vi.useRealTimers();
    }

    expect(spawned).toHaveBeenNthCalledWith(1, HELPER_PATH, ["--send-enter"]);
    expect(spawned).toHaveBeenNthCalledWith(2, HELPER_PATH, []);
  });

  test("reports an Enter the helper pressed on a target it could not read", async () => {
    const manager = new ClipboardManager();
    vi.spyOn(manager, "getFastPastePath").mockReturnValue(HELPER_PATH);
    const notConfirmed = Object.assign(new Error("not confirmed"), {
      code: "WINDOWS_PASTE_NOT_CONFIRMED",
      dispatched: true,
      evidence: "none",
      enterSent: true,
    });
    vi.spyOn(manager, "pasteWithFastPaste").mockRejectedValue(notConfirmed);

    await expect(manager.pasteWindows({ text: "before" }, { sendEnter: true })).resolves.toEqual({
      delivered: false,
      evidence: "none",
      dispatched: true,
      enterSent: true,
      fallback: "clipboard",
      method: "windows-fast-paste",
    });
  });

  test("keeps the transcript on the clipboard when the helper is missing", async () => {
    const manager = new ClipboardManager();
    vi.spyOn(manager, "getFastPastePath").mockReturnValue(null);

    // No helper means nothing was ever sent, so the text really is not in the
    // target field and the user is worth telling.
    await expect(manager.pasteWindows({ text: "before" })).resolves.toEqual({
      delivered: false,
      evidence: "absent",
      dispatched: false,
      enterSent: false,
      fallback: "clipboard",
      method: "windows-fast-paste",
    });
  });

  test("does not attempt an unconfirmable second paste when the helper fails", async () => {
    const manager = new ClipboardManager();
    vi.spyOn(manager, "getFastPastePath").mockReturnValue(HELPER_PATH);
    vi.spyOn(manager, "pasteWithFastPaste").mockRejectedValue(new Error("SendInput failed"));

    await expect(manager.pasteWindows({ text: "before" })).resolves.toEqual({
      delivered: false,
      evidence: "absent",
      dispatched: false,
      enterSent: false,
      fallback: "clipboard",
      method: "windows-fast-paste",
    });
  });

  test("does not replace a negative paste acknowledgement with an unconfirmed legacy success", async () => {
    const manager = new ClipboardManager();
    vi.spyOn(manager, "getFastPastePath").mockReturnValue(HELPER_PATH);
    const notConfirmed = Object.assign(new Error("not confirmed"), {
      code: "WINDOWS_PASTE_NOT_CONFIRMED",
      dispatched: true,
      evidence: "absent",
    });
    vi.spyOn(manager, "pasteWithFastPaste").mockRejectedValue(notConfirmed);

    await expect(manager.pasteWindows({ text: "before" })).resolves.toEqual({
      delivered: false,
      evidence: "absent",
      dispatched: true,
      enterSent: false,
      fallback: "clipboard",
      method: "windows-fast-paste",
    });
  });

  // A helper that could not read the target says so, and that has to reach the
  // caller intact or the app warns about a paste nobody can say failed.
  test("passes an unreadable target through instead of calling it a failure", async () => {
    const manager = new ClipboardManager();
    vi.spyOn(manager, "getFastPastePath").mockReturnValue(HELPER_PATH);
    const unreadable = Object.assign(new Error("not confirmed"), {
      code: "WINDOWS_PASTE_NOT_CONFIRMED",
      dispatched: true,
      evidence: "none",
    });
    vi.spyOn(manager, "pasteWithFastPaste").mockRejectedValue(unreadable);

    await expect(manager.pasteWindows({ text: "before" })).resolves.toEqual({
      delivered: false,
      evidence: "none",
      dispatched: true,
      enterSent: false,
      fallback: "clipboard",
      method: "windows-fast-paste",
    });
  });
});
