import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
import { evidenceDir } from "./fixtures/evidence";

test.use({
  fakeAudioCaptureFile: path.resolve("tests/fixtures/dictation/banana.wav"),
  seedWhisperModels: ["base"],
});

test("replaces a running but frozen meter during startup", async ({
  electronApp,
  overlayWindow,
}) => {
  const shots = evidenceDir(`meter-startup-${process.env.PT_METER_PHASE || "after"}`);
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
    window.AudioContext = class extends NativeContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        contexts.push(this);
        if (contexts.length === 1) {
          // Reproduce the device-wake failure: state says running, but the
          // engine produces no samples. MediaRecorder still records the WAV.
          void this.suspend();
          Object.defineProperty(this, "state", { get: () => "running" });
          Object.defineProperty(this, "currentTime", { get: () => 0 });
          this.resume = () => Promise.resolve();
        }
      }
    };
  });
  await overlayWindow.reload();
  await expect(overlayWindow.getByRole("button", { name: "Dictation overlay" })).toBeVisible();
  await overlayWindow.mouse.move(10, 10);
  await overlayWindow.screenshot({ path: path.join(shots, "idle.png") });
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((win) => !win.webContents.getURL().includes("panel=true"))!
      .webContents.send("toggle-dictation");
  });
  const bars = overlayWindow.locator('div[style*="scaleY("]');
  await expect(bars).toHaveCount(5);
  await overlayWindow.waitForTimeout(900);
  await overlayWindow.screenshot({ path: path.join(shots, "startup.png") });
  const contextCount = await overlayWindow.evaluate(
    () => (window as unknown as { meterContexts: AudioContext[] }).meterContexts.length
  );
  expect(contextCount, "replace a frozen startup engine within one second").toBe(2);
  const samples: string[] = [];
  for (let i = 0; i < 15; i++) {
    samples.push((await bars.nth(2).getAttribute("style"))!);
    await overlayWindow.waitForTimeout(100);
  }
  expect(new Set(samples).size).toBeGreaterThan(3);
  await expect
    .poll(async () => {
      const style = await bars.nth(2).getAttribute("style");
      return Number(style?.match(/scaleY\(([0-9.]+)\)/)?.[1]);
    })
    .toBeGreaterThan(0.42);
  await overlayWindow.screenshot({ path: path.join(shots, "speech.png") });
  await overlayWindow.keyboard.press("Escape");
  await expect(bars).toHaveCount(0);
  await overlayWindow.mouse.move(10, 10);
  await overlayWindow.waitForTimeout(400);
  await overlayWindow.screenshot({ path: path.join(shots, "cancelled.png") });
});
