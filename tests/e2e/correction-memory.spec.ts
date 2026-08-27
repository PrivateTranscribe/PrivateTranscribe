import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";
import { unlockTesterAccess } from "./fixtures/tester-access";

/**
 * Correction Memory, end to end, against the claim the feature makes about
 * itself:
 *
 *   "Correction Memory captures phrase fixes you confirm and applies them to
 *    every future dictation automatically."
 *
 * Every earlier test of this feature checked a piece: the database writes a
 * row, snapTranscript rewrites a string. Neither one can fail in a way a user
 * would notice, because the user never touches either — they speak, and the
 * text that lands is either fixed or it is not. So this spec speaks.
 *
 * The microphone is real code and fake hardware: Chromium's
 * `--use-file-for-fake-audio-capture` plays a committed WAV into
 * getUserMedia, so MediaRecorder, the IPC hop, the temp file, whisper.cpp, the
 * snapper and the history write all run exactly as they do for a user, and the
 * machine's own microphone is never opened. Nothing is stubbed downstream of
 * the microphone, and nothing is written to the OS clipboard or pasted into
 * whatever the developer had focused — `autoPaste` and `copyToClipboard` are
 * both off, so a completed dictation goes only to the throwaway database.
 *
 * Three acts, in one test because each depends on the state the last one left:
 *
 *   a. BASELINE — dictate the fixture with no corrections stored. The
 *      transcript must contain the source word. This is what proves the later
 *      rewrite is a rewrite and not a coincidence.
 *   b. TEACH    — add the correction through the real "Add a correction" UI.
 *   c. APPLY    — dictate the SAME audio again. The new history row must carry
 *      the replacement and must no longer carry the source word.
 */

const FIXTURE_DIR = path.resolve(__dirname, "..", "fixtures", "dictation");
const WAV = path.join(FIXTURE_DIR, "banana.wav");
const TRUTH = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "banana.truth.json"), "utf8")) as {
  text: string;
  sha256: string;
  totalSec: number;
  correctionSource: string;
  correctionTarget: string;
};

const BASE_MODEL = path.join(
  os.homedir(),
  ".cache",
  "PrivateTranscribe",
  "whisper-models",
  "ggml-base.bin"
);
const GOAL_EVIDENCE_DIR = path.resolve(__dirname, "..", "..", "docs", "goal-evidence");

/**
 * Record for two full clip lengths.
 *
 * Chromium loops the capture file continuously, and the app pools the
 * microphone stream between dictations — so the second dictation starts at an
 * arbitrary point in the loop, not at the top of the file. A one-length
 * recording of a rotated clip can therefore begin mid-word, and an observed run
 * produced "Backpack yesterday. I put the banana." A window of at least one
 * full period plus one sentence always contains one uncut pass of the sentence;
 * two periods is that with room to spare, and costs a couple of seconds of
 * whisper time.
 */
const RECORD_MS = Math.ceil(TRUTH.totalSec * 1000) * 2;

test.use({ fakeAudioCaptureFile: WAV, appEnv: { WHISPER_FORCE_CPU: "true" } });

type HistoryRow = { id: number; text: string };
type CorrectionRow = { source: string; target: string; count: number; confirmed: number };

const api = (page: Page) => page.evaluate.bind(page) as Page["evaluate"];

/**
 * The recording halo — rendered only while `micState === "recording"`. The
 * overlay is deliberately invisible and click-through during a test run, so
 * recording state has to be read out of the DOM rather than off the screen.
 */
const recordingHalo = (overlay: Page) =>
  overlay.locator('div[aria-hidden="true"][style*="width: 68px"][style*="radial-gradient"]');

/** Newest first, by id — `timestamp` only has second resolution. */
async function readHistory(page: Page): Promise<HistoryRow[]> {
  const rows = (await api(page)(() =>
    (window as unknown as { electronAPI: any }).electronAPI.getTranscriptions(50)
  )) as HistoryRow[];
  return [...rows].sort((a, b) => b.id - a.id);
}

async function readCorrections(page: Page): Promise<CorrectionRow[]> {
  return (await api(page)(() =>
    (window as unknown as { electronAPI: any }).electronAPI.getCorrectionMemory(200)
  )) as CorrectionRow[];
}

/**
 * Everything a dictation run must not inherit from the developer's machine,
 * plus the two settings that keep a completed dictation off the desktop.
 */
async function configureDictation(page: Page): Promise<void> {
  await api(page)(() => {
    localStorage.setItem("useLocalWhisper", "true");
    localStorage.setItem("whisperModel", "base");
    localStorage.setItem("localTranscriptionProvider", "whisper");
    localStorage.setItem("useReasoningModel", "false");
    localStorage.setItem("whisperForceCpu", "true");
    // The snapper is what applies corrections; assert the default rather than
    // silently depending on it.
    localStorage.setItem("enableVariableSnapping", "true");
    // No paste, no clipboard write: a run must not touch whatever the developer
    // has focused, and must not overwrite their clipboard.
    localStorage.setItem("autoPaste", "false");
    localStorage.setItem("copyToClipboard", "false");
    // Auto-learning polls the OS clipboard for 30s after each dictation. This
    // spec teaches its correction through the UI instead, so it stays off.
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

/**
 * Give the OVERLAY window its own tester entitlement.
 *
 * `_serverVerifiedBetaAccess` is module state, set only by a successful
 * licensing-server response, and each window runs its own copy of the module.
 * Activating in the control panel therefore unlocks the control panel and
 * nothing else — the overlay, which is where dictation actually completes,
 * stays locked.
 *
 * The overlay's only route to the flag is its own start-up `refreshProStatus()`
 * re-activating the cached key. So: install the stub as an init script (it runs
 * before app code on the next navigation) and reload. The counter is not
 * decoration — if act (c) ever fails, it is the difference between "the stub
 * was never reached" and "the stub was reached and the flag still did not
 * take".
 */
async function grantOverlayBetaAccess(overlay: Page): Promise<void> {
  await overlay.addInitScript(() => {
    (window as unknown as { __e2eActivateCalls: number }).__e2eActivateCalls = 0;
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/licensing/activate")) {
        (window as unknown as { __e2eActivateCalls: number }).__e2eActivateCalls += 1;
        return new Response(
          JSON.stringify({
            success: true,
            entitlement: { token: "e2e-token", expiresAt: null, betaAccess: true },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return realFetch(input, init);
    };
  });

  await overlay.reload({ waitUntil: "domcontentloaded" });
  await expect(recordingHalo(overlay)).toHaveCount(0);

  await expect
    .poll(
      () =>
        overlay.evaluate(
          () => (window as unknown as { __e2eActivateCalls?: number }).__e2eActivateCalls ?? 0
        ),
      { timeout: 20_000 }
    )
    .toBeGreaterThan(0);
}

/**
 * One dictation, driven the way the hotkey drives it: the main process sends
 * `toggle-dictation` to the overlay's webContents. First toggle records, second
 * stops and transcribes.
 */
async function dictateFixture(app: ElectronApplication, overlay: Page): Promise<void> {
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

async function openDictionaryPage(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Dictionary", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Correction Memory", exact: true })).toBeVisible();
}

test.describe("Correction Memory", () => {
  test("applies a confirmed fix to a later dictation, through the real pipeline", async ({
    electronApp,
    overlayWindow,
    controlPanel,
  }) => {
    // Two real whisper decodes, an activation round-trip and two window
    // reloads. The default 90s budget is for specs that only touch the UI.
    test.setTimeout(300_000);

    // No silent skip. A machine without the model must say so rather than
    // report a pass it never earned.
    expect(
      fs.existsSync(BASE_MODEL),
      `ggml-base.bin is not installed at ${BASE_MODEL} — download it before running this spec`
    ).toBe(true);

    // The fixture is frozen; a regenerated WAV that changed would quietly
    // change what this test means.
    const wavHash = crypto.createHash("sha256").update(fs.readFileSync(WAV)).digest("hex");
    expect(wavHash).toBe(TRUTH.sha256);

    const SOURCE = TRUTH.correctionSource;
    const TARGET = TRUTH.correctionTarget;

    await unlockTesterAccess(controlPanel);
    await configureDictation(controlPanel);
    await grantOverlayBetaAccess(overlayWindow);

    // ── act a: baseline ────────────────────────────────────────────────────
    expect(await readCorrections(controlPanel)).toHaveLength(0);
    expect(await readHistory(controlPanel)).toHaveLength(0);

    await dictateFixture(electronApp, overlayWindow);

    await expect
      .poll(async () => (await readHistory(controlPanel)).length, {
        timeout: 180_000,
        intervals: [1000],
      })
      .toBe(1);

    const baseline = (await readHistory(controlPanel))[0];
    console.log(`[act a] baseline transcript: ${JSON.stringify(baseline.text)}`);
    expect(baseline.text.toLowerCase()).toContain(SOURCE.toLowerCase());
    expect(baseline.text.toLowerCase()).toContain("backpack");
    expect(baseline.text).not.toContain(TARGET);

    // ── act b: teach ───────────────────────────────────────────────────────
    await openDictionaryPage(controlPanel);

    await controlPanel.getByPlaceholder("Source word - e.g. cloud").fill(SOURCE);
    await controlPanel.getByPlaceholder("Replacement word - e.g. Claude").fill(TARGET);
    await controlPanel.getByRole("button", { name: "Add correction", exact: true }).click();

    const listedRow = controlPanel
      .locator("div")
      .filter({ hasText: new RegExp(`^${SOURCE}→${TARGET}`) })
      .first();
    await expect(listedRow).toBeVisible();
    await expect(controlPanel.getByText("1 entry", { exact: true })).toBeVisible();

    // The UI listing it is not the same as the snapper being able to use it:
    // tokenSnapper skips any row whose `confirmed` is falsy.
    const stored = await readCorrections(controlPanel);
    console.log(`[act b] correction rows: ${JSON.stringify(stored)}`);
    expect(stored).toHaveLength(1);
    expect(stored[0].source).toBe(SOURCE);
    expect(stored[0].target).toBe(TARGET);
    expect(Boolean(stored[0].confirmed)).toBe(true);

    fs.mkdirSync(GOAL_EVIDENCE_DIR, { recursive: true });
    await listedRow.scrollIntoViewIfNeeded();
    await controlPanel.screenshot({
      path: path.join(GOAL_EVIDENCE_DIR, "correction-memory-taught.png"),
      fullPage: true,
      animations: "disabled",
    });

    // ── act c: apply ───────────────────────────────────────────────────────
    // Same audio, same settings, one row already committed — so the only thing
    // that changed between act (a) and here is the confirmed correction.
    await dictateFixture(electronApp, overlayWindow);

    await expect
      .poll(async () => (await readHistory(controlPanel)).length, {
        timeout: 180_000,
        intervals: [1000],
      })
      .toBe(2);

    const applied = (await readHistory(controlPanel))[0];
    console.log(`[act c] corrected transcript: ${JSON.stringify(applied.text)}`);
    expect(applied.id).not.toBe(baseline.id);
    expect(applied.text).toContain(TARGET);
    expect(applied.text.toLowerCase()).not.toContain(SOURCE.toLowerCase());

    // The rest of the sentence must survive: a rewrite that mangled everything
    // else would also satisfy the two assertions above.
    expect(applied.text.toLowerCase()).toContain("backpack");

    await controlPanel.getByRole("button", { name: "History", exact: true }).click();
    await expect(controlPanel.getByText(TARGET, { exact: false }).first()).toBeVisible();
    await controlPanel.screenshot({
      path: path.join(GOAL_EVIDENCE_DIR, "correction-memory-applied.png"),
      fullPage: true,
      animations: "disabled",
    });
  });
});
