import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import AudioManager from "../../../src/helpers/audioManager";
import { deliverDictation } from "../../../src/utils/dictationDelivery";

const filename = path.resolve("src/helpers/clipboard.js");
const requireHelper = createRequire(filename);

afterEach(() => {
  vi.useRealTimers();
});

describe("Windows clipboard handoff through the renderer", () => {
  test.each(["none", "absent"])(
    "keeps the original clipboard write when insertion evidence is %s",
    async (evidence) => {
      vi.useFakeTimers();
      const clipboard = {
        readText: () => "old clipboard",
        readHTML: () => "",
        readRTF: () => "",
        readImage: () => ({ isEmpty: () => true }),
        writeText: vi.fn(),
        write: vi.fn(),
      };
      const module = { exports: undefined as any };
      vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
        module,
        __dirname: path.dirname(filename),
        setTimeout,
        clearTimeout,
        console,
        process: { platform: "win32", env: {} },
        require: (name: string) => {
          if (name === "electron") return { clipboard, app: {} };
          return requireHelper(name);
        },
      });
      const manager = new module.exports();
      manager.pasteDiagnostics.record = vi.fn();
      manager.fastPasteChecked = true;
      manager.fastPastePath = "fake-helper.exe";
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      manager._spawnFastPaste = () => child;
      global.window.electronAPI = { pasteText: (text: string) => manager.pasteText(text) };
      const copy = vi.fn((text: string) => clipboard.writeText(text));
      const pending = deliverDictation({
        text: "new transcript",
        shouldPersist: false,
        shouldPaste: true,
        shouldCopy: true,
        persist: vi.fn(),
        copy,
        paste: (text: string) => AudioManager.prototype.safePaste.call({}, text),
      });
      await vi.advanceTimersByTimeAsync(30);
      child.stdout.emit(
        "data",
        Buffer.from(JSON.stringify({ pasted: false, evidence, dispatched: true }))
      );
      child.emit("close", 0);
      const result = await pending;
      expect(clipboard.writeText.mock.calls).toEqual([["new transcript"]]);
      expect(clipboard.write).not.toHaveBeenCalled();
      expect(copy).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        copied: true,
        pasteConfirmed: false,
        pasteDispatched: true,
        recoverable: true,
      });
    }
  );
});
