import fs from "node:fs";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";

/**
 * The overlay's resting shape.
 *
 * Idle, the dictation button is a short line, not a disc. It opens into the
 * 44px circle when the pointer rests on it, when a recording starts, and it
 * stays open through the decode, then closes again. The line rests a little
 * above the circle's bottom edge and the circle grows mostly upward from it,
 * because the 44px hit box underneath never changes size.
 *
 * Each state is captured as well as asserted, so a change to the shape can be
 * judged by eye. Set PT_SHOT_DIR to choose where the shots land; it defaults
 * to docs/goal-evidence.
 */

const FIXTURE_DIR = path.resolve(__dirname, "..", "fixtures", "dictation");
const SHOT_DIR = process.env.PT_SHOT_DIR
  ? path.resolve(process.env.PT_SHOT_DIR)
  : path.resolve(__dirname, "..", "..", "docs", "goal-evidence");
const MIN_SCREENSHOT_BYTES = 500;

/** The bottom of the 400x500 window, where the button and its halo live. */
const CLIP = { x: 0, y: 280, width: 400, height: 220 };

const recordingHalo = (overlay: Page) =>
  overlay.locator('div[aria-hidden="true"][style*="width: 68px"][style*="radial-gradient"]');

const dictationButton = (overlay: Page) =>
  overlay.getByRole("button", { name: "Dictation overlay" });

/** Mirrors the constants in src/App.jsx. A change here is a change of design. */
const HIT_BOX = 44;
const REST_W = 28;
const REST_H = 6;
const REST_LIFT = 10;

/**
 * The visible shell is this size, centred left to right on the hit box, with
 * its bottom edge `lift` above the hit box's bottom edge. The circle fills the
 * hit box (lift 0); the line rests a little above its bottom (REST_LIFT).
 * Measured once the open or close transition has landed, never mid-way.
 */
async function expectShell(overlay: Page, width: number, height: number, lift: number) {
  const button = dictationButton(overlay);
  const shell = button.locator(".overlay-shell");
  await shell.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });

  const shellBox = await shell.boundingBox();
  const buttonBox = await button.boundingBox();
  expect(shellBox, "the shell has no box to measure").not.toBeNull();
  expect(buttonBox, "the dictation button has no box to measure").not.toBeNull();
  if (!shellBox || !buttonBox) return;

  expect(Math.round(buttonBox.width), "hit box width never changes").toBe(HIT_BOX);
  expect(Math.round(buttonBox.height), "hit box height never changes").toBe(HIT_BOX);
  expect(Math.round(shellBox.width), "shell width").toBe(width);
  expect(Math.round(shellBox.height), "shell height").toBe(height);

  const dx = shellBox.x + shellBox.width / 2 - (buttonBox.x + buttonBox.width / 2);
  const gap = buttonBox.y + buttonBox.height - (shellBox.y + shellBox.height);
  expect(Math.abs(dx), "shell is centred on the anchor, horizontally").toBeLessThan(1.5);
  expect(
    Math.abs(gap - lift),
    "shell rests the expected lift above the anchor's bottom"
  ).toBeLessThan(1.5);
}

async function capture(page: Page, fileName: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const filePath = path.join(SHOT_DIR, fileName);
  await page.screenshot({ path: filePath, clip: CLIP });
  const bytes = fs.statSync(filePath).size;
  expect(bytes, `${fileName} is too small to show anything (${bytes} bytes)`).toBeGreaterThan(
    MIN_SCREENSHOT_BYTES
  );
}

async function configureDictation(overlay: Page): Promise<void> {
  await overlay.evaluate(() => {
    localStorage.setItem("useLocalWhisper", "true");
    localStorage.setItem("whisperModel", "base");
    localStorage.setItem("localTranscriptionProvider", "whisper");
    localStorage.setItem("useReasoningModel", "false");
    localStorage.setItem("whisperForceCpu", "true");
    localStorage.setItem("autoPaste", "false");
    localStorage.setItem("copyToClipboard", "false");
    localStorage.setItem("enableCorrectionLearning", "false");
    localStorage.setItem("enablePhraseCorrectionLearning", "false");
    localStorage.setItem("actionEngineEnabled", "false");
    localStorage.setItem("audioFeedback", "false");
    localStorage.setItem("successConfirmation", "false");
    localStorage.setItem("customDictionary", "[]");
  });
  await overlay.evaluate(() =>
    (window as unknown as { electronAPI: any }).electronAPI.setWhisperForceCpu(true)
  );
  await overlay.reload({ waitUntil: "domcontentloaded" });
  await expect(dictationButton(overlay)).toBeVisible();
}

async function toggleDictation(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && !w.webContents.getURL().includes("panel=true")
    );
    if (!win) throw new Error("no dictation overlay window to toggle");
    win.webContents.send("toggle-dictation");
  });
}

test.describe("overlay resting shape", () => {
  test.use({
    fakeAudioCaptureFile: path.join(FIXTURE_DIR, "banana.wav"),
    seedRealWhisperModels: ["base"],
    appEnv: { WHISPER_FORCE_CPU: "true" },
  });

  test("every state of the dictation button", async ({ electronApp, overlayWindow }) => {
    test.setTimeout(180_000);
    await configureDictation(overlayWindow);
    const button = dictationButton(overlayWindow);

    // Idle: the mouse is somewhere else entirely, and the button is a line.
    await overlayWindow.mouse.move(10, 10);
    await overlayWindow.waitForTimeout(600);
    await expectShell(overlayWindow, REST_W, REST_H, REST_LIFT);
    await capture(overlayWindow, "overlay-shape-idle.png");

    // Hover: the pointer rests on the button, and the line opens into the circle.
    await button.hover();
    await overlayWindow.waitForTimeout(600);
    await expectShell(overlayWindow, HIT_BOX, HIT_BOX, 0);
    await capture(overlayWindow, "overlay-shape-hover.png");

    // Leaving closes it again, at once.
    await overlayWindow.mouse.move(10, 10);
    await overlayWindow.waitForTimeout(400);
    await expectShell(overlayWindow, REST_W, REST_H, REST_LIFT);

    // Dragging: the window follows the mouse a frame or two behind, so the
    // pointer leaves the button mid-drag. The circle stays in the user's hand
    // until they let go.
    const grab = await button.boundingBox();
    expect(grab, "the dictation button has no box to grab").not.toBeNull();
    if (!grab) return;
    await overlayWindow.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2);
    await overlayWindow.mouse.down();
    await overlayWindow.mouse.move(grab.x + 40, grab.y - 40, { steps: 6 });
    await overlayWindow.mouse.move(10, 10, { steps: 6 });
    await overlayWindow.waitForTimeout(400);
    await expectShell(overlayWindow, HIT_BOX, HIT_BOX, 0);
    await capture(overlayWindow, "overlay-shape-dragging.png");
    await overlayWindow.mouse.up();
    await overlayWindow.waitForTimeout(400);
    await expectShell(overlayWindow, REST_W, REST_H, REST_LIFT);

    // Recording: driven the way the hotkey drives it, with the fake mic playing.
    await toggleDictation(electronApp);
    await expect(recordingHalo(overlayWindow)).toHaveCount(1, { timeout: 30_000 });
    await overlayWindow.waitForTimeout(2_500);
    await expectShell(overlayWindow, HIT_BOX, HIT_BOX, 0);
    await capture(overlayWindow, "overlay-shape-recording.png");

    // Processing: the halo goes, the decode is still running, the circle stays.
    await toggleDictation(electronApp);
    await expect(recordingHalo(overlayWindow)).toHaveCount(0, { timeout: 60_000 });
    await overlayWindow.waitForTimeout(250);
    await capture(overlayWindow, "overlay-shape-processing.png");
    await expectShell(overlayWindow, HIT_BOX, HIT_BOX, 0);

    // Idle again, once the decode has finished: back to the line.
    await expect(button).toHaveCSS("cursor", "pointer", { timeout: 90_000 });
    await overlayWindow.waitForTimeout(600);
    await expectShell(overlayWindow, REST_W, REST_H, REST_LIFT);
    await capture(overlayWindow, "overlay-shape-idle-after.png");
  });
});
