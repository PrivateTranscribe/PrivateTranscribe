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

describe("ClipboardManager Windows paste routing", () => {
  test("passes the terminal paste chord to nircmd", async () => {
    const manager = new ClipboardManager();
    vi.spyOn(manager, "detectWindowsPasteTarget").mockResolvedValue({
      processName: "WindowsTerminal.exe",
    });
    vi.spyOn(manager, "getNircmdPath").mockReturnValue("C:\\tools\\nircmd.exe");
    const paste = vi.spyOn(manager, "pasteWithNircmd").mockResolvedValue(undefined);

    await manager.pasteWindows({});

    expect(paste).toHaveBeenCalledWith(
      "C:\\tools\\nircmd.exe",
      {},
      {
        isTerminal: true,
        nircmdKeys: "ctrl+shift+v",
        sendKeys: "^+v",
      }
    );
  });

  test("keeps Ctrl+V for ordinary Windows application fields", async () => {
    const manager = new ClipboardManager();
    vi.spyOn(manager, "detectWindowsPasteTarget").mockResolvedValue({ processName: "notepad.exe" });
    vi.spyOn(manager, "getNircmdPath").mockReturnValue(null);
    const paste = vi.spyOn(manager, "pasteWithPowerShell").mockResolvedValue(undefined);

    await manager.pasteWindows({});

    expect(paste).toHaveBeenCalledWith(
      {},
      {
        isTerminal: false,
        nircmdKeys: "ctrl+v",
        sendKeys: "^v",
      }
    );
  });
});
