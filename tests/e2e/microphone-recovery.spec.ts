import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
import { evidenceDir } from "./fixtures/evidence";

const shots = evidenceDir("qa-0.17.1");
const phase = "after";

test.describe("microphone recovery", () => {
  test.use({
    fakeAudioCaptureFile: path.resolve("tests/fixtures/dictation/banana.wav"),
    seedWhisperModels: ["base"],
  });

  test("recovers bars when the first AudioContext resume never settles", async ({
    electronApp,
    overlayWindow,
  }) => {
    fs.mkdirSync(shots, { recursive: true });
    await overlayWindow.evaluate(() => {
      localStorage.setItem("autoPaste", "false");
      localStorage.setItem("copyToClipboard", "false");
      localStorage.setItem("audioFeedback", "false");
      localStorage.setItem("useReasoningModel", "false");
    });
    await overlayWindow.addInitScript(() => {
      const NativeContext = window.AudioContext;
      const contexts: AudioContext[] = [];
      (window as unknown as { meterContexts: AudioContext[] }).meterContexts = contexts;
      let first = true;
      window.AudioContext = class extends NativeContext {
        constructor(options?: AudioContextOptions) {
          super(options);
          contexts.push(this);
          if (first) {
            first = false;
            void this.suspend();
            this.resume = () => new Promise<void>(() => {});
          }
        }
      };
    });
    await overlayWindow.reload();
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((w) => !w.webContents.getURL().includes("panel=true"))!
        .webContents.send("toggle-dictation");
    });
    const bars = overlayWindow.locator('div[style*="scaleY("]');
    await expect(bars).toHaveCount(5);
    await overlayWindow.waitForTimeout(1500);
    const samples: string[] = [];
    for (let i = 0; i < 15; i++) {
      samples.push((await bars.nth(2).getAttribute("style"))!);
      await overlayWindow.waitForTimeout(120);
    }
    expect(new Set(samples).size).toBeGreaterThan(3);
    // Capture a frame with speech, rather than the silence between WAV loops.
    await expect
      .poll(async () => {
        const style = await bars.nth(2).getAttribute("style");
        return Number(style?.match(/scaleY\(([0-9.]+)\)/)?.[1]);
      })
      .toBeGreaterThan(0.42);
    await overlayWindow.screenshot({ path: path.join(shots, `${phase}-bars-recording.png`) });

    // Reproduce display/device suspension halfway through the same recording.
    await overlayWindow.evaluate(async () => {
      const ctx = (window as unknown as { meterContexts: AudioContext[] }).meterContexts.at(-1)!;
      await ctx.suspend();
      ctx.resume = () => new Promise<void>(() => {});
    });
    await overlayWindow.waitForTimeout(4500);
    const recovered: string[] = [];
    for (let i = 0; i < 15; i++) {
      recovered.push((await bars.nth(2).getAttribute("style"))!);
      await overlayWindow.waitForTimeout(120);
    }
    expect(new Set(recovered).size).toBeGreaterThan(3);
    await overlayWindow.keyboard.press("Escape");
    await expect(bars).toHaveCount(0);
    await overlayWindow.mouse.move(10, 10);
    await overlayWindow.waitForTimeout(500);
    await overlayWindow.screenshot({ path: path.join(shots, `${phase}-bars-idle.png`) });
  });
});
