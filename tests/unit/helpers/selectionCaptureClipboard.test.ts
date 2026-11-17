import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { afterEach, describe, expect, test, vi } from "vitest";

const filename = path.resolve("src/helpers/selectionCapture.js");
const requireHelper = createRequire(filename);
const screenshot = "PNG bytes of a screenshot";

// The clipboard as MIME type -> payload, as Electron's clipboard.read() lists it.
type ClipboardContents = Record<string, string>;

// Electron's ClipboardItem: getType resolves to a Blob for every type used here.
class FakeClipboardItem {
  constructor(private readonly items: Record<string, Blob | string>) {}

  get types() {
    return Object.keys(this.items);
  }

  async getType(type: string) {
    const value = this.items[type];
    if (value === undefined) throw new Error(`No ${type} on the clipboard`);
    return value instanceof Blob ? value : new Blob([value], { type });
  }
}

// Load the real CommonJS capture implementation with an isolated clipboard.
// writeText deliberately replaces every format, as Electron does; a mock that
// only changed text would hide the data loss this regression test exercises.
// Only clear() empties it.
function createCapture(original: ClipboardContents, platform = "win32") {
  let contents = { ...original };
  const clipboard = {
    read: vi.fn(async () =>
      Object.keys(contents).length > 0 ? [new FakeClipboardItem({ ...contents })] : []
    ),
    readText: vi.fn(async () => contents["text/plain"] || ""),
    writeText: vi.fn(async (text: string) => {
      contents = { "text/plain": text };
    }),
    write: vi.fn(async (items: FakeClipboardItem[]) => {
      const next: ClipboardContents = {};
      for (const item of items) {
        for (const type of item.types) next[type] = await (await item.getType(type)).text();
      }
      contents = next;
    }),
    clear: vi.fn(() => {
      contents = {};
    }),
  };
  const module = { exports: undefined as any };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module,
    __dirname: path.dirname(filename),
    process: { platform },
    Date,
    setTimeout,
    clearTimeout,
    require: (name: string) => {
      if (name === "electron") return { clipboard, ClipboardItem: FakeClipboardItem };
      if (name === "./debugLogger") return { debug: vi.fn() };
      return requireHelper(name);
    },
  });
  const capture = new module.exports();
  capture.worker = {};
  capture.waitForReady = vi.fn().mockResolvedValue(true);
  capture.sendCopyKeystroke = vi.fn(async () => {
    await clipboard.writeText("Selected text to read aloud.");
    return "OK waited=120ms";
  });
  return { capture, clipboard, contents: () => contents };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Read Aloud selection capture clipboard preservation", () => {
  test.each([
    { name: "plain text", original: { "text/plain": "Original text" } },
    {
      name: "formatted text",
      original: {
        "text/plain": "Original text",
        "text/html": "<b>Original text</b>",
        "text/rtf": "{\\rtf1 Original text}",
      },
    },
    { name: "an image without text", original: { "image/png": screenshot } },
    { name: "a copied file", original: { "text/uri-list": "file:///C:/Notes/zorblat.txt" } },
    {
      name: "text, HTML, RTF and an image together",
      original: {
        "text/plain": "Screenshot",
        "text/html": "<b>Screenshot</b>",
        "text/rtf": "{\\rtf1 Screenshot}",
        "image/png": screenshot,
      },
    },
  ])("restores $name after a successful capture", async ({ original }) => {
    const { capture, clipboard, contents } = createCapture(original);

    const result = await capture.captureSelection();

    expect(result).toMatchObject({
      text: "Selected text to read aloud.",
      source: "selection",
      waitedMs: 120,
    });
    expect(contents()).toEqual(original);
    expect(clipboard.write).toHaveBeenCalledTimes(1);
  });

  test("leaves raw platform formats out of the snapshot", async () => {
    const { capture, contents } = createCapture({
      "text/plain": "Cell",
      "text/html": "<td>Cell</td>",
      'electron application/osclipboard;format="Biff12"': "native cell data",
    });

    expect(await capture.captureSelection()).toMatchObject({ source: "selection" });
    expect(contents()).toEqual({ "text/plain": "Cell", "text/html": "<td>Cell</td>" });
  });

  test("clears an originally empty clipboard instead of leaving the selection on it", async () => {
    const { capture, clipboard, contents } = createCapture({});

    expect(await capture.captureSelection()).toMatchObject({ source: "selection" });
    expect(contents()).toEqual({});
    expect(clipboard.clear).toHaveBeenCalledTimes(1);
  });

  test("clears an originally empty clipboard instead of leaving the sentinel on it", async () => {
    vi.useFakeTimers();
    const { capture, contents } = createCapture({});
    capture.sendCopyKeystroke.mockResolvedValue("ERR timeout");

    const pending = capture.captureSelection();
    await vi.runAllTimersAsync();

    expect(await pending).toMatchObject({ text: "", source: "none" });
    expect(contents()).toEqual({});
  });

  test("recognizes a selection equal to the original clipboard text", async () => {
    const original = { "text/plain": "Same text", "text/html": "<b>Same text</b>" };
    const { capture, clipboard, contents } = createCapture(original);
    capture.sendCopyKeystroke.mockImplementation(async () => {
      await clipboard.writeText(original["text/plain"]);
      return "OK waited=0ms";
    });

    expect(await capture.captureSelection()).toMatchObject({
      text: "Same text",
      source: "selection",
    });
    expect(contents()).toEqual(original);
  });

  test.each(["OK waited=0ms", "ERR worker not ready", "ERR timeout"])(
    "restores formatting and falls back to the original text when copying returns %s without text",
    async (detail) => {
      vi.useFakeTimers();
      const original = {
        "text/plain": "Fallback text",
        "text/html": "<b>Fallback text</b>",
        "image/png": screenshot,
      };
      const { capture, contents } = createCapture(original);
      capture.sendCopyKeystroke.mockResolvedValue(detail);

      const pending = capture.captureSelection();
      await vi.runAllTimersAsync();

      expect(await pending).toMatchObject({ text: "Fallback text", source: "clipboard", detail });
      expect(contents()).toEqual(original);
    }
  );

  test("preserves an image-only clipboard when there is no text to read", async () => {
    vi.useFakeTimers();
    const original = { "image/png": screenshot };
    const { capture, contents } = createCapture(original);
    capture.sendCopyKeystroke.mockResolvedValue("ERR timeout");

    const pending = capture.captureSelection();
    await vi.runAllTimersAsync();

    expect(await pending).toMatchObject({ text: "", source: "none" });
    expect(contents()).toEqual(original);
  });

  test("restores all captured formats if the copy operation throws", async () => {
    const original = {
      "text/plain": "Original",
      "text/html": "<b>Original</b>",
      "image/png": screenshot,
    };
    const { capture, contents } = createCapture(original);
    capture.sendCopyKeystroke.mockRejectedValue(new Error("Copy failed"));

    await expect(capture.captureSelection()).rejects.toThrow("Copy failed");
    expect(contents()).toEqual(original);
  });

  test("restores all captured formats if clipboard polling throws", async () => {
    const original = {
      "text/plain": "Original",
      "text/rtf": "{\\rtf1 Original}",
      "image/png": screenshot,
    };
    const { capture, clipboard, contents } = createCapture(original);
    clipboard.readText.mockRejectedValueOnce(new Error("Clipboard unavailable"));

    await expect(capture.captureSelection()).rejects.toThrow("Clipboard unavailable");
    expect(contents()).toEqual(original);
  });

  test("restores at least plain text if writing multiple formats fails", async () => {
    const { capture, clipboard, contents } = createCapture({
      "text/plain": "Original",
      "image/png": screenshot,
    });
    clipboard.write.mockRejectedValueOnce(new Error("Clipboard busy"));

    expect(await capture.captureSelection()).toMatchObject({ source: "selection" });
    expect(contents()).toEqual({ "text/plain": "Original" });
    expect(clipboard.writeText).toHaveBeenLastCalledWith("Original");
  });

  test("does not mask a copy failure if both restoration attempts fail", async () => {
    const { capture, clipboard } = createCapture({
      "text/plain": "Original",
      "image/png": screenshot,
    });
    capture.sendCopyKeystroke.mockRejectedValue(new Error("Copy failed"));
    clipboard.write.mockRejectedValueOnce(new Error("Clipboard busy"));
    clipboard.writeText
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Clipboard still busy"));

    await expect(capture.captureSelection()).rejects.toThrow("Copy failed");
  });

  test("does not overwrite the clipboard if reading its original formats fails", async () => {
    const original = { "text/plain": "Original", "image/png": screenshot };
    const { capture, clipboard, contents } = createCapture(original);
    clipboard.read.mockRejectedValueOnce(new Error("Clipboard unavailable"));

    await expect(capture.captureSelection()).rejects.toThrow("Clipboard unavailable");
    expect(contents()).toEqual(original);
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(capture.sendCopyKeystroke).not.toHaveBeenCalled();
  });

  test("leaves the clipboard untouched on unsupported platforms", async () => {
    const original = { "image/png": screenshot };
    const { capture, clipboard, contents } = createCapture(original, "linux");

    expect(await capture.captureSelection()).toMatchObject({ text: "", source: "unsupported" });
    expect(contents()).toEqual(original);
    expect(clipboard.read).not.toHaveBeenCalled();
    expect(clipboard.readText).not.toHaveBeenCalled();
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(clipboard.write).not.toHaveBeenCalled();
  });
  // A second press of the shortcut can land while the first capture still
  // runs: the worker waits up to two seconds for the trigger keys to be let go
  // before it copies. The second capture then took the first one's sentinel
  // for the user's clipboard and put that back last.
  test("keeps the original clipboard when a second capture starts before the first ends", async () => {
    const original = {
      "text/plain": "Original text",
      "text/html": "<b>Original text</b>",
      "image/png": screenshot,
    };
    const { capture, clipboard, contents } = createCapture(original);
    const queuedCopies: Array<() => void> = [];
    capture.sendCopyKeystroke = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          queuedCopies.push(async () => {
            await clipboard.writeText("Selected text to read aloud.");
            resolve("OK waited=120ms");
          });
        })
    );
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    const first = capture.captureSelection();
    const second = capture.captureSelection();
    await settle();
    // The worker runs its copies one at a time.
    while (queuedCopies.length > 0) {
      queuedCopies.shift()!();
      await settle();
    }

    const selection = { text: "Selected text to read aloud.", source: "selection" };
    expect(await first).toMatchObject(selection);
    expect(await second).toMatchObject(selection);
    expect(contents()).toEqual(original);

    // Only overlapping presses share a result: a later press copies afresh.
    const third = capture.captureSelection();
    await settle();
    queuedCopies.shift()!();
    expect(await third).toMatchObject(selection);
    expect(capture.sendCopyKeystroke).toHaveBeenCalledTimes(2);
    expect(contents()).toEqual(original);
  });

  test("captures again after a capture that failed", async () => {
    const original = { "text/plain": "Original" };
    const { capture, clipboard, contents } = createCapture(original);
    clipboard.read.mockRejectedValueOnce(new Error("Clipboard unavailable"));
    await expect(capture.captureSelection()).rejects.toThrow("Clipboard unavailable");

    expect(await capture.captureSelection()).toMatchObject({ source: "selection" });
    expect(contents()).toEqual(original);
  });
});
