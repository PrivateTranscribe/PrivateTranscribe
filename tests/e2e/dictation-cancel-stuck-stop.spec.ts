import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
import {
  configureLocalWhisperDictation,
  historyTexts,
  readPastes,
  recordPastes,
  toggleDictation,
} from "./fixtures/app-drive";

/**
 * Escape has to cancel a dictation that is stuck finishing.
 *
 * MediaRecorder sometimes never fires its stop event. The app then waits 30
 * seconds and finishes the dictation with the audio it has. A cancel during
 * that wait used to be forgotten: the hotkey did nothing for 30 seconds, and
 * then the cancelled dictation was transcribed and pasted into whatever window
 * was in front.
 *
 * The fault is put where it happens for a user: the recorder takes the stop
 * call and stays silent. Everything else is the app as it ships, with a real
 * Whisper decode, so a paste of the cancelled dictation would be seen.
 */

const FIXTURE_DIR = path.resolve(__dirname, "..", "fixtures", "dictation");

/** The app's own wait for a recorder that never reports its stop. */
const STUCK_STOP_WAIT_MS = 30_000;

type RecorderProbe = { hang: boolean; starts: number; swallowedStops: number };

test.use({
  fakeAudioCaptureFile: path.join(FIXTURE_DIR, "banana.wav"),
  seedRealWhisperModels: ["base"],
  appEnv: { WHISPER_FORCE_CPU: "true" },
});

test("Escape cancels a dictation whose recorder never reports its stop", async ({
  electronApp,
  overlayWindow,
}) => {
  test.setTimeout(180_000);

  await configureLocalWhisperDictation(overlayWindow);
  await recordPastes(electronApp);

  await overlayWindow.evaluate(() => {
    const probe = { hang: false, starts: 0, swallowedStops: 0 };
    (window as unknown as { __recorderProbe: typeof probe }).__recorderProbe = probe;
    const start = MediaRecorder.prototype.start;
    MediaRecorder.prototype.start = function (...args) {
      probe.starts += 1;
      return start.apply(this, args);
    };
    const stop = MediaRecorder.prototype.stop;
    MediaRecorder.prototype.stop = function () {
      if (probe.hang) {
        probe.swallowedStops += 1;
        return;
      }
      return stop.call(this);
    };
  });
  const probe = () =>
    overlayWindow.evaluate(
      () => (window as unknown as { __recorderProbe: RecorderProbe }).__recorderProbe
    );
  const setHang = (hang: boolean) =>
    overlayWindow.evaluate((value) => {
      (window as unknown as { __recorderProbe: RecorderProbe }).__recorderProbe.hang = value;
    }, hang);

  // The dictation that gets stuck.
  await toggleDictation(electronApp);
  await expect.poll(async () => (await probe()).starts, { timeout: 30_000 }).toBeGreaterThan(0);
  await overlayWindow.waitForTimeout(4_000);
  // One dictation starts more than one recorder, so later ones are counted from here.
  const startsOfFirst = (await probe()).starts;

  await setHang(true);
  await toggleDictation(electronApp);
  await expect
    .poll(async () => (await probe()).swallowedStops, { timeout: 10_000 })
    .toBeGreaterThan(0);
  const stopPressedAt = Date.now();

  await overlayWindow.waitForTimeout(1_000);
  await overlayWindow.keyboard.press("Escape");

  // "You can dictate again at once": well inside the 30 second wait.
  await overlayWindow.waitForTimeout(1_500);
  await setHang(false);
  await toggleDictation(electronApp);
  await expect
    .poll(async () => (await probe()).starts, {
      timeout: 8_000,
      message: "the hotkey did nothing after the cancel",
    })
    .toBeGreaterThan(startsOfFirst);

  await overlayWindow.waitForTimeout(6_000);
  await toggleDictation(electronApp);
  await expect
    .poll(async () => (await readPastes(electronApp)).length, { timeout: 90_000 })
    .toBe(1);

  // Wait past the moment the old watchdog would have pasted the cancelled one.
  const leftOfOldWait = stopPressedAt + STUCK_STOP_WAIT_MS + 8_000 - Date.now();
  if (leftOfOldWait > 0) await overlayWindow.waitForTimeout(leftOfOldWait);

  const pastes = await readPastes(electronApp);
  expect(pastes, "the cancelled dictation was pasted after all").toHaveLength(1);
  expect(pastes[0].text.toLowerCase()).toContain("banana");
  expect(await historyTexts(overlayWindow)).toHaveLength(1);
});
