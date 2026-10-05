import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { afterEach, describe, expect, test, vi } from "vitest";

const filename = path.resolve("src/helpers/selectionCapture.js");
const requireHelper = createRequire(filename);
const emptyImage = { isEmpty: () => true };
const screenshot = { isEmpty: () => false };

type ClipboardContents = {
  text?: string;
  html?: string;
  rtf?: string;
  image?: typeof screenshot;
};

// Load the real CommonJS capture implementation with an isolated clipboard.
// writeText deliberately replaces every format, as Electron does; a mock that
// only changed text would hide the data loss this regression test exercises.
function createCapture(original: ClipboardContents, platform = "win32") {
  let contents = { ...original };
  const clipboard = {
    readText: vi.fn(() => contents.text || ""),
    readHTML: vi.fn(() => contents.html || ""),
    readRTF: vi.fn(() => contents.rtf || ""),
    readImage: vi.fn(() => contents.image || emptyImage),
    writeText: vi.fn((text: string) => {
      contents = { text };
    }),
    write: vi.fn((payload: ClipboardContents) => {
      contents = { ...payload };
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
      if (name === "electron") return { clipboard };
      if (name === "./debugLogger") return { debug: vi.fn() };
      return requireHelper(name);
    },
  });
  const capture = new module.exports();
  capture.worker = {};
  capture.waitForReady = vi.fn().mockResolvedValue(true);
  capture.sendCopyKeystroke = vi.fn(async () => {
    clipboard.writeText("Selected text to read aloud.");
    return "OK waited=120ms";
  });
  return { capture, clipboard, contents: () => contents };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Read Aloud selection capture clipboard preservation", () => {
  test.each([
    { name: "plain text", original: { text: "Original text" } },
    {
      name: "formatted text",
      original: {
        text: "Original text",
        html: "<b>Original text</b>",
        rtf: "{\\rtf1 Original text}",
      },
    },
    { name: "an image without text", original: { image: screenshot } },
    {
      name: "text, HTML, RTF and an image together",
      original: {
        text: "Screenshot",
        html: "<b>Screenshot</b>",
        rtf: "{\\rtf1 Screenshot}",
        image: screenshot,
      },
    },
    { name: "an empty clipboard", original: {} },
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
    expect(clipboard.write).toHaveBeenCalledWith(original);
  });

  test("recognizes a selection equal to the original clipboard text", async () => {
    const original = { text: "Same text", html: "<b>Same text</b>" };
    const { capture, clipboard, contents } = createCapture(original);
    capture.sendCopyKeystroke.mockImplementation(async () => {
      clipboard.writeText(original.text);
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
      const original = { text: "Fallback text", html: "<b>Fallback text</b>", image: screenshot };
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
    const original = { image: screenshot };
    const { capture, contents } = createCapture(original);
    capture.sendCopyKeystroke.mockResolvedValue("ERR timeout");

    const pending = capture.captureSelection();
    await vi.runAllTimersAsync();

    expect(await pending).toMatchObject({ text: "", source: "none" });
    expect(contents()).toEqual(original);
  });

  test("restores all captured formats if the copy operation throws", async () => {
    const original = { text: "Original", html: "<b>Original</b>", image: screenshot };
    const { capture, contents } = createCapture(original);
    capture.sendCopyKeystroke.mockRejectedValue(new Error("Copy failed"));

    await expect(capture.captureSelection()).rejects.toThrow("Copy failed");
    expect(contents()).toEqual(original);
  });

  test("restores all captured formats if clipboard polling throws", async () => {
    const original = { text: "Original", rtf: "{\\rtf1 Original}", image: screenshot };
    const { capture, clipboard, contents } = createCapture(original);
    clipboard.readText.mockReturnValueOnce(original.text).mockImplementationOnce(() => {
      throw new Error("Clipboard unavailable");
    });

    await expect(capture.captureSelection()).rejects.toThrow("Clipboard unavailable");
    expect(contents()).toEqual(original);
  });

  test("restores at least plain text if writing multiple formats fails", async () => {
    const { capture, clipboard, contents } = createCapture({ text: "Original", image: screenshot });
    clipboard.write.mockImplementationOnce(() => {
      throw new Error("Clipboard busy");
    });

    expect(await capture.captureSelection()).toMatchObject({ source: "selection" });
    expect(contents()).toEqual({ text: "Original" });
    expect(clipboard.writeText).toHaveBeenLastCalledWith("Original");
  });

  test("does not mask a copy failure if both restoration attempts fail", async () => {
    const { capture, clipboard } = createCapture({ text: "Original", image: screenshot });
    capture.sendCopyKeystroke.mockRejectedValue(new Error("Copy failed"));
    clipboard.write.mockImplementationOnce(() => {
      throw new Error("Clipboard busy");
    });
    clipboard.writeText
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("Clipboard still busy");
      });

    await expect(capture.captureSelection()).rejects.toThrow("Copy failed");
  });

  test("does not overwrite the clipboard if reading its original formats fails", async () => {
    const original = { text: "Original", image: screenshot };
    const { capture, clipboard, contents } = createCapture(original);
    clipboard.readHTML.mockImplementationOnce(() => {
      throw new Error("Clipboard unavailable");
    });

    await expect(capture.captureSelection()).rejects.toThrow("Clipboard unavailable");
    expect(contents()).toEqual(original);
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(capture.sendCopyKeystroke).not.toHaveBeenCalled();
  });

  test("leaves the clipboard untouched on unsupported platforms", async () => {
    const original = { image: screenshot };
    const { capture, clipboard, contents } = createCapture(original, "linux");

    expect(await capture.captureSelection()).toMatchObject({ text: "", source: "unsupported" });
    expect(contents()).toEqual(original);
    expect(clipboard.readText).not.toHaveBeenCalled();
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(clipboard.write).not.toHaveBeenCalled();
  });
});
