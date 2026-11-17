import fs from "node:fs";
import path from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";
import {
  configureLocalWhisperDictation,
  installAppRequire,
  readPastes,
  recordingHalo,
  recordPastes,
  toggleDictation,
} from "./fixtures/app-drive";

/**
 * A long dictation started right after a cancelled one has to be pasted whole.
 *
 * A dictation over a minute is transcribed in pieces while it records. A cancel
 * during its final processing does not stop a piece already sent to the engine.
 * When that piece came back, the cancelled job used to reset the long-dictation
 * state, which by then belonged to the next recording: everything the new one
 * had transcribed so far was dropped, and it pasted only its last part behind a
 * "[... missing section ...]".
 *
 * Both dictations here are real and over a minute, so the spec takes about
 * three minutes. The one thing held back is the cancelled dictation's last
 * piece, the way a slow engine on a busy PC holds it.
 */

/**
 * The microphone plays a 96 second interview on a loop. The banana clip will
 * not do here: the app takes one sentence said twelve times for a Whisper loop
 * and keeps it once, so a whole dictation and a cut one look the same.
 */
const FIXTURE_DIR = path.resolve(__dirname, "..", "fixtures", "multispeaker");
const INTERVIEW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, "interview.truth.json"), "utf8")
) as { totalSec: number; utterances: Array<{ text: string }> };
const INTERVIEW_WORDS = INTERVIEW.utterances
  .map((utterance) => utterance.text.split(/\s+/).length)
  .reduce((sum, words) => sum + words, 0);

/** A dictation becomes a long one at 60 seconds. */
const PAST_THE_FIRST_MINUTE_MS = 68_000;
/** About how long the new dictation records in all: the wait above and a few seconds more. */
const NEW_DICTATION_SEC = 73;

test.use({
  fakeAudioCaptureFile: path.join(FIXTURE_DIR, "interview.wav"),
  seedRealWhisperModels: ["base"],
  appEnv: { WHISPER_FORCE_CPU: "true" },
});

type Hold = { armed: boolean; held: number; release: (() => void) | null; returned: boolean };

/** Let a spec hold one transcription back inside the main process. */
async function installHold(app: ElectronApplication): Promise<void> {
  await installAppRequire(app);
  await app.evaluate(() => {
    const g = globalThis as unknown as {
      __ptE2eRequire: (file: string) => any;
      __ptE2eLive: Record<string, any>;
    };
    const hold: Hold = { armed: false, held: 0, release: null, returned: false };
    g.__ptE2eLive.hold = hold;
    const proto = g.__ptE2eRequire("src/helpers/whisper.js").prototype;
    const transcribe = proto.transcribeLocalWhisper;
    proto.transcribeLocalWhisper = async function (this: unknown, ...args: unknown[]) {
      if (!hold.armed) return transcribe.apply(this, args);
      hold.armed = false;
      hold.held += 1;
      await new Promise<void>((resolve) => {
        hold.release = resolve;
      });
      try {
        return await transcribe.apply(this, args);
      } finally {
        hold.returned = true;
      }
    };
  });
}

const hold = (app: ElectronApplication) =>
  app.evaluate(
    () => (globalThis as unknown as { __ptE2eLive: Record<string, any> }).__ptE2eLive.hold as Hold
  );

test("a long dictation started after a cancelled one is pasted whole", async ({
  electronApp,
  overlayWindow,
}) => {
  test.setTimeout(480_000);

  await configureLocalWhisperDictation(overlayWindow);
  await recordPastes(electronApp);
  await installHold(electronApp);

  // The dictation that gets cancelled. Its last piece is held at the engine.
  await toggleDictation(electronApp);
  await expect(recordingHalo(overlayWindow)).toHaveCount(1, { timeout: 30_000 });
  await overlayWindow.waitForTimeout(PAST_THE_FIRST_MINUTE_MS);
  await electronApp.evaluate(() => {
    (globalThis as unknown as { __ptE2eLive: Record<string, any> }).__ptE2eLive.hold.armed = true;
  });
  await toggleDictation(electronApp);
  await expect
    .poll(async () => (await hold(electronApp)).held, {
      timeout: 30_000,
      message: "the cancelled dictation's last piece never reached the engine",
    })
    .toBe(1);
  await overlayWindow.keyboard.press("Escape");

  // The next long dictation, started at once.
  await overlayWindow.waitForTimeout(500);
  await toggleDictation(electronApp);
  await expect(recordingHalo(overlayWindow)).toHaveCount(1, { timeout: 15_000 });
  await overlayWindow.waitForTimeout(PAST_THE_FIRST_MINUTE_MS);

  // Now the cancelled dictation's piece comes back, a minute into the new one.
  await electronApp.evaluate(() => {
    (globalThis as unknown as { __ptE2eLive: Record<string, any> }).__ptE2eLive.hold.release?.();
  });
  await expect
    .poll(async () => (await hold(electronApp)).returned, {
      timeout: 120_000,
      message: "the held piece never came back from the engine",
    })
    .toBe(true);
  // Room for the cancelled job to act on it before the new dictation stops.
  await overlayWindow.waitForTimeout(3_000);
  await toggleDictation(electronApp);

  await expect
    .poll(async () => (await readPastes(electronApp)).length, { timeout: 180_000 })
    .toBe(1);
  const pasted = (await readPastes(electronApp))[0].text;

  expect(pasted).not.toContain("missing section");
  // The words spoken in 73 seconds of the interview, at its average pace. A
  // whole dictation has most of them. One that lost its first minute has what
  // the last 13 seconds hold, under a fifth.
  const wordsSpoken = Math.round((INTERVIEW_WORDS * NEW_DICTATION_SEC) / INTERVIEW.totalSec);
  const wordsPasted = pasted.split(/\s+/).filter(Boolean).length;
  console.log(`[long dictation] pasted ${wordsPasted} of about ${wordsSpoken} words spoken`);
  expect(wordsPasted, `only part of the dictation was pasted: ${pasted}`).toBeGreaterThan(
    wordsSpoken * 0.6
  );
});
