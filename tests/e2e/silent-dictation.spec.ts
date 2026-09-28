import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";
import { enableBetaFeatures, enableBetaFeaturesInOverlay } from "./fixtures/tester-access";

/**
 * A dictation nobody spoke into must produce nothing.
 *
 * Whisper cannot answer "nothing was said". Handed an open microphone it
 * invents text, and the app pastes it into whatever the user was typing in.
 * Two defences catch that, and this spec exists because each one was built
 * against a case the other misses:
 *
 *   - AudioManager measures the microphone and refuses to send a recording
 *     with no sound in it at all.
 *   - The transcript is checked for whisper's subtitle annotations and the
 *     stock phrases it emits in place of silence.
 *
 * The second defence is not belt and braces. Faint breath measures at the same
 * amplitude as quiet speech, so no level gate can separate them, and whisper
 * reports no_speech_prob 0.00 on the invented "Thank you." against 0.56 on
 * real speech - the engine is more confident in the invention. Both defences
 * therefore have to be exercised against audio that actually reaches them.
 *
 * Every silent fixture here was verified to produce a hallucination with the
 * defences removed: breath gave "Thank you.", typing gave "[BANG]" then "You".
 * A fixture that cannot fail proves nothing, so if these are ever regenerated,
 * re-check that first.
 *
 * The spoken case runs the identical setup and requires a row, so a broken
 * recorder cannot make the whole spec pass by transcribing nothing at all.
 */

const FIXTURE_DIR = path.resolve(__dirname, "..", "fixtures", "dictation");
const SPEECH_WAV = path.join(FIXTURE_DIR, "banana.wav");

const BASE_MODEL = path.join(
  os.homedir(),
  ".cache",
  "PrivateTranscribe",
  "whisper-models",
  "ggml-base.bin"
);

/** Longer than the 6s fixtures, so a looped clip cannot be why nothing lands. */
const RECORD_MS = 8000;

/**
 * How long history is watched after a silent dictation before calling it
 * empty. Generous on purpose: a hallucinated row would be written by whisper
 * finishing, so this has to outlast a cold model load to mean anything.
 */
const SETTLE_MS = 45_000;

type HistoryRow = { id: number; text: string };

const api = (page: Page) => page.evaluate.bind(page) as Page["evaluate"];

const recordingHalo = (overlay: Page) =>
  overlay.locator('div[aria-hidden="true"][style*="width: 68px"][style*="radial-gradient"]');

/** Everything the app has written to its own debug log this run. */
function readAppLog(userDataDir: string): string {
  const logsDir = path.join(userDataDir, "logs");
  if (!fs.existsSync(logsDir)) return "";
  return fs
    .readdirSync(logsDir)
    .filter((name) => name.endsWith(".log"))
    .map((name) => fs.readFileSync(path.join(logsDir, name), "utf8"))
    .join("\n");
}

async function readHistory(page: Page): Promise<HistoryRow[]> {
  const rows = (await api(page)(() =>
    (window as unknown as { electronAPI: any }).electronAPI.getTranscriptions(50)
  )) as HistoryRow[];
  return [...rows].sort((a, b) => b.id - a.id);
}

/** Local whisper, and nothing that reaches the clipboard or the desktop. */
async function configureDictation(page: Page): Promise<void> {
  await api(page)(() => {
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
  await api(page)(() =>
    (window as unknown as { electronAPI: any }).electronAPI.setWhisperForceCpu(true)
  );
}

/** One dictation, driven the way the hotkey drives it. */
async function dictate(app: ElectronApplication, overlay: Page): Promise<void> {
  const toggle = () =>
    app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && !w.webContents.getURL().includes("panel=true")
      );
      if (!win) throw new Error("no dictation overlay window to toggle");
      win.webContents.send("toggle-dictation");
    });

  const halo = recordingHalo(overlay);
  await toggle();
  await expect(halo).toHaveCount(1, { timeout: 30_000 });
  await overlay.waitForTimeout(RECORD_MS);
  await toggle();
  await expect(halo).toHaveCount(0, { timeout: 60_000 });
}

async function prepare(controlPanel: Page, overlayWindow: Page): Promise<void> {
  expect(
    fs.existsSync(BASE_MODEL),
    `ggml-base.bin is not installed at ${BASE_MODEL} - download it before running this spec`
  ).toBe(true);
  await enableBetaFeatures(controlPanel);
  await configureDictation(controlPanel);
  await enableBetaFeaturesInOverlay(overlayWindow);
}

/**
 * Dictate a fixture that holds no speech and require an empty history.
 *
 * `logMarkers` pins which defence had to have stopped it, so a pass cannot
 * mean a broken recorder instead of a working gate. Renderer logs are
 * forwarded to the main process rather than printed, so the app's own log file
 * is where the line lands.
 *
 * Pass an empty list where the route is not fixed. Whisper is not
 * deterministic on non-speech audio - the same clip returned " You" on one run
 * and "Thank you for watching." on the next - so which defence fires can vary
 * even though the outcome must not. `dictate` already proves the recorder ran.
 */
async function expectNothingDictated(
  label: string,
  logMarkers: string[],
  {
    electronApp,
    overlayWindow,
    controlPanel,
    userDataDir,
  }: {
    electronApp: ElectronApplication;
    overlayWindow: Page;
    controlPanel: Page;
    userDataDir: string;
  }
): Promise<void> {
  await prepare(controlPanel, overlayWindow);
  expect(await readHistory(controlPanel)).toHaveLength(0);

  await dictate(electronApp, overlayWindow);

  if (logMarkers.length > 0) {
    await expect
      .poll(
        () => {
          const log = readAppLog(userDataDir);
          return logMarkers.some((marker) => log.includes(marker));
        },
        { timeout: 60_000, intervals: [500] }
      )
      .toBe(true);
  }

  await controlPanel.waitForTimeout(SETTLE_MS);
  const history = await readHistory(controlPanel);
  console.log(`[${label}] history after ${SETTLE_MS}ms: ${JSON.stringify(history)}`);
  expect(history).toHaveLength(0);
}

/** PT_LOG_LEVEL turns on the file log the defences' own lines are read back from. */
const SILENT_ENV = { WHISPER_FORCE_CPU: "true", PT_LOG_LEVEL: "debug" };

test.describe("an open microphone with nothing in it", () => {
  test.use({ fakeAudioCaptureFile: path.join(FIXTURE_DIR, "silence.wav"), appEnv: SILENT_ENV });

  test("never reaches the engine at all", async ({
    electronApp,
    overlayWindow,
    controlPanel,
    userDataDir,
  }) => {
    test.setTimeout(300_000);
    await expectNothingDictated("silence", ["held no speech"], {
      electronApp,
      overlayWindow,
      controlPanel,
      userDataDir,
    });
  });
});

test.describe("faint breath and rustle", () => {
  test.use({ fakeAudioCaptureFile: path.join(FIXTURE_DIR, "breath.wav"), appEnv: SILENT_ENV });

  // Produced "Thank you." with the defences removed - the phrase users report.
  test("does not become an invented stock phrase", async ({
    electronApp,
    overlayWindow,
    controlPanel,
    userDataDir,
  }) => {
    test.setTimeout(300_000);
    await expectNothingDictated("breath", ["Dropped a non-speech transcript"], {
      electronApp,
      overlayWindow,
      controlPanel,
      userDataDir,
    });
  });
});

test.describe("keyboard noise", () => {
  test.use({ fakeAudioCaptureFile: path.join(FIXTURE_DIR, "typing.wav"), appEnv: SILENT_ENV });

  // Produced "[BANG]" and "You" with the defences removed.
  test("does not become a subtitle annotation", async ({
    electronApp,
    overlayWindow,
    controlPanel,
    userDataDir,
  }) => {
    test.setTimeout(300_000);
    await expectNothingDictated(
      "typing",
      // Observed both ways across runs: the annotation whisper invents, or an
      // empty decode that never produces a transcript to drop.
      // Whisper's output on this clip varies run to run, so the assertion is
      // on the outcome alone: whatever it invented must not reach history.
      [],
      {
        electronApp,
        overlayWindow,
        controlPanel,
        userDataDir,
      }
    );
  });
});

test.describe("speech in", () => {
  test.use({ fakeAudioCaptureFile: SPEECH_WAV, appEnv: { WHISPER_FORCE_CPU: "true" } });

  test("still reaches the engine and lands in history", async ({
    electronApp,
    overlayWindow,
    controlPanel,
  }) => {
    test.setTimeout(300_000);
    await prepare(controlPanel, overlayWindow);
    expect(await readHistory(controlPanel)).toHaveLength(0);

    await dictate(electronApp, overlayWindow);

    await expect
      .poll(async () => (await readHistory(controlPanel)).length, {
        timeout: 180_000,
        intervals: [1000],
      })
      .toBe(1);

    const row = (await readHistory(controlPanel))[0];
    console.log(`[speech] transcript: ${JSON.stringify(row.text)}`);
    expect(row.text.toLowerCase()).toContain("backpack");
  });
});
