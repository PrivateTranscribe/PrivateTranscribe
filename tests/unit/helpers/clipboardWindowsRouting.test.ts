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
const PLAIN_CTRL_V = { isTerminal: false, nircmdKeys: "ctrl+v", sendKeys: "^v" };

describe("ClipboardManager Windows paste routing", () => {
  test("uses the native fast paste helper when it is available", async () => {
    const manager = new ClipboardManager();
    vi.spyOn(manager, "getFastPastePath").mockReturnValue(HELPER_PATH);
    const fastPaste = vi.spyOn(manager, "pasteWithFastPaste").mockResolvedValue(undefined);
    const nircmd = vi.spyOn(manager, "pasteWithNircmd").mockResolvedValue(undefined);
    const powershell = vi.spyOn(manager, "pasteWithPowerShell").mockResolvedValue(undefined);

    await manager.pasteWindows({ text: "before" });

    expect(fastPaste).toHaveBeenCalledWith(HELPER_PATH, { text: "before" });
    expect(nircmd).not.toHaveBeenCalled();
    expect(powershell).not.toHaveBeenCalled();
  });

  test("falls back to nircmd with plain Ctrl+V when the helper is missing", async () => {
    const manager = new ClipboardManager();
    vi.spyOn(manager, "getFastPastePath").mockReturnValue(null);
    vi.spyOn(manager, "getNircmdPath").mockReturnValue("C:\\tools\\nircmd.exe");
    const nircmd = vi.spyOn(manager, "pasteWithNircmd").mockResolvedValue(undefined);

    await manager.pasteWindows({ text: "before" });

    expect(nircmd).toHaveBeenCalledWith("C:\\tools\\nircmd.exe", { text: "before" }, PLAIN_CTRL_V);
  });

  test("falls back to PowerShell when neither the helper nor nircmd is available", async () => {
    const manager = new ClipboardManager();
    vi.spyOn(manager, "getFastPastePath").mockReturnValue(null);
    vi.spyOn(manager, "getNircmdPath").mockReturnValue(null);
    const powershell = vi.spyOn(manager, "pasteWithPowerShell").mockResolvedValue(undefined);

    await manager.pasteWindows({ text: "before" });

    expect(powershell).toHaveBeenCalledWith({ text: "before" }, PLAIN_CTRL_V);
  });

  test("falls back to the legacy path when the helper itself fails", async () => {
    const manager = new ClipboardManager();
    vi.spyOn(manager, "getFastPastePath").mockReturnValue(HELPER_PATH);
    vi.spyOn(manager, "pasteWithFastPaste").mockRejectedValue(new Error("SendInput failed"));
    vi.spyOn(manager, "getNircmdPath").mockReturnValue("C:\\tools\\nircmd.exe");
    const nircmd = vi.spyOn(manager, "pasteWithNircmd").mockResolvedValue(undefined);

    await manager.pasteWindows({ text: "before" });

    expect(nircmd).toHaveBeenCalledWith("C:\\tools\\nircmd.exe", { text: "before" }, PLAIN_CTRL_V);
  });

  test("does not replace a negative paste acknowledgement with an unconfirmed legacy success", async () => {
    const manager = new ClipboardManager();
    vi.spyOn(manager, "getFastPastePath").mockReturnValue(HELPER_PATH);
    const notConfirmed = Object.assign(new Error("not confirmed"), {
      code: "WINDOWS_PASTE_NOT_CONFIRMED",
      dispatched: true,
    });
    vi.spyOn(manager, "pasteWithFastPaste").mockRejectedValue(notConfirmed);
    const nircmd = vi.spyOn(manager, "pasteWithNircmd").mockResolvedValue(undefined);
    const powershell = vi.spyOn(manager, "pasteWithPowerShell").mockResolvedValue(undefined);

    await expect(manager.pasteWindows({ text: "before" })).resolves.toEqual({
      delivered: false,
      dispatched: true,
      fallback: "clipboard",
      method: "windows-fast-paste",
    });
    expect(nircmd).not.toHaveBeenCalled();
    expect(powershell).not.toHaveBeenCalled();
  });
});
