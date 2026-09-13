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

  test("records split progress lines and an unconfirmed dispatch without retaining text", async () => {
    const manager = new ClipboardManager();
    const record = vi.spyOn(manager.pasteDiagnostics, "record").mockResolvedValue(undefined);
    vi.spyOn(manager, "_spawnFastPaste").mockReturnValue(child);
    const pending = manager.pasteWithFastPaste("C:\\helper.exe", { text: "before" });
    const failed = expect(pending).rejects.toMatchObject({ code: "WINDOWS_PASTE_NOT_CONFIRMED" });
    await vi.advanceTimersByTimeAsync(30);
    child.stderr.emit("data", Buffer.from("PT_PASTE_STAGE inp"));
    child.stderr.emit("data", Buffer.from("ut\nPT_PASTE_STAGE dispatched\n"));
    child.stdout.emit(
      "data",
      Buffer.from(
        '{"pasted":false,"dispatched":true,"evidence":"none","heldModifierCount":2,"targetChanged":false}'
      )
    );
    child.emit("close", 0);
    await failed;
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "unconfirmed",
        stage: "dispatched",
        dispatched: true,
        heldModifierCount: 2,
        targetChanged: false,
      })
    );
  });

  test("records the last native stage when the helper times out", async () => {
    const manager = new ClipboardManager();
    const record = vi.spyOn(manager.pasteDiagnostics, "record").mockResolvedValue(undefined);
    vi.spyOn(manager, "_spawnFastPaste").mockReturnValue(child);
    const pending = manager.pasteWithFastPaste("C:\\helper.exe", { text: "before" });
    const failed = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(30);
    child.stderr.emit("data", Buffer.from("PT_PASTE_STAGE clipboard\n"));
    await vi.advanceTimersByTimeAsync(2500);
    await failed;
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "timeout",
        stage: "clipboard",
        dispatched: null,
        elapsedMs: 2500,
      })
    );
  });
});
