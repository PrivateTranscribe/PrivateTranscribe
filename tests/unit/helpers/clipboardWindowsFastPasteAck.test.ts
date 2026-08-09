import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const child = new EventEmitter() as EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
};
child.stdout = new EventEmitter();
child.stderr = new EventEmitter();

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

describe("ClipboardManager native Windows acknowledgement", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    child.removeAllListeners();
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("rejects instead of throwing from the child-process close callback", async () => {
    const manager = new ClipboardManager();
    vi.spyOn(manager, "_spawnFastPaste").mockReturnValue(child);
    const pending = manager.pasteWithFastPaste("C:\\helper.exe", { text: "before" });

    await vi.advanceTimersByTimeAsync(30);
    child.stdout.emit("data", Buffer.from('{"pasted":false,"isTerminal":false}'));
    child.emit("close", 0);

    await expect(pending).rejects.toMatchObject({ code: "WINDOWS_PASTE_NOT_CONFIRMED" });
  });
});
