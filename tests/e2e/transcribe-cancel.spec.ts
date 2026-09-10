import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";

/**
 * Stopping a running file transcription — audit F1.
 *
 * Before this, a dropped file could only be escaped by force-quitting the app:
 * every click handler returned early on status "processing", no IPC channel
 * existed, and no AbortSignal reached the http.request inside the decode loop.
 *
 * Two things are asserted here, and the second is the one that could quietly go
 * wrong. Cancelling has to stop the run AND leave the shared whisper-server
 * alone: it is the same warm process dictation uses, so a cancel that restarted
 * it (or marked it dead) would charge the next dictation a cold start it never
 * asked for. The proof is the server's own pid, read from the main process
 * before and after — plus a real transcription afterwards, because a live pid
 * says nothing about a server that has stopped answering.
 *
 * Design note, measured rather than assumed: whisper-server does NOT keep
 * grinding on an aborted request. With a 12.8-minute decode aborted at +6s, the
 * next request on the same server took 610-620ms against a 593-604ms baseline
 * (two runs). So the abort simply drops the request — the server is not
 * restarted on cancel.
 *
 * Real audio, real CPU decode, own port, own model — never the whisper-server
 * the installed app may be running.
 */
test.use({ appEnv: { WHISPER_FORCE_CPU: "true" } });

const INTERVIEW_WAV = path.resolve(__dirname, "..", "fixtures", "multispeaker", "interview.wav");
const BANANA_WAV = path.resolve(__dirname, "..", "fixtures", "dictation", "banana.wav");
const BASE_MODEL = path.join(
  os.homedir(),
  ".cache",
  "PrivateTranscribe",
  "whisper-models",
  "ggml-base.bin"
);
const GOAL_EVIDENCE_DIR = path.resolve(__dirname, "..", "..", "docs", "goal-evidence");

async function readWhisperPid(page: Page): Promise<number | null> {
  const diagnostics = await page.evaluate(() =>
    (window as unknown as { electronAPI: any }).electronAPI.getAudioDiagnostics()
  );
  return diagnostics?.lastSpawn?.pid ?? null;
}

/**
 * Pin the run to the CPU engine and wait for the pin to land.
 *
 * WHISPER_FORCE_CPU alone is not enough: useSettings pushes the renderer's
 * stored `whisperForceCpu` down over IPC on mount, which clears the env-set
 * flag again (recorded as a side finding by the language spec).
 */
async function prepareForLocalTranscription(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem("useLocalWhisper", "true");
    localStorage.setItem("whisperModel", "base");
    localStorage.setItem("fileTranscriptionSpeakerDetection", "false");
    localStorage.setItem("fileTranscriptionLanguage", "en");
    localStorage.setItem("whisperForceCpu", "true");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.evaluate(() =>
    (window as unknown as { electronAPI: any }).electronAPI.setWhisperForceCpu(true)
  );
}

async function openTranscribePage(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Transcribe File", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Transcribe", exact: true })).toBeVisible();
}

test.describe("Transcribe page cancel", () => {
  test("stops a running transcription and leaves the engine usable", async ({ controlPanel }) => {
    // No silent skip: a machine without the model should say so, not report a
    // pass it never earned.
    expect(
      fs.existsSync(BASE_MODEL),
      `ggml-base.bin is not installed at ${BASE_MODEL} — download it before running this spec`
    ).toBe(true);

    await prepareForLocalTranscription(controlPanel);
    await openTranscribePage(controlPanel);

    fs.mkdirSync(GOAL_EVIDENCE_DIR, { recursive: true });

    // 96 seconds of audio: long enough that a decode is genuinely in flight
    // while the Cancel button is being clicked.
    await controlPanel.locator('input[type="file"]').setInputFiles(INTERVIEW_WAV);

    const cancelButton = controlPanel.getByRole("button", { name: "Cancel", exact: true });
    await expect(cancelButton).toBeVisible({ timeout: 30_000 });
    await expect(controlPanel.getByRole("heading", { name: "Transcribing…" })).toBeVisible();

    await controlPanel.screenshot({
      path: path.join(GOAL_EVIDENCE_DIR, "transcribe-cancel.png"),
      fullPage: true,
      animations: "disabled",
    });

    const pidDuringRun = await readWhisperPid(controlPanel);
    expect(Number(pidDuringRun)).toBeGreaterThan(0);

    await cancelButton.click();

    // Calm, not red: a cancel is a decision the user made, not a failure.
    await expect(controlPanel.getByRole("heading", { name: "Cancelled" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(controlPanel.getByRole("heading", { name: "Transcription failed" })).toHaveCount(
      0
    );
    await expect(controlPanel.getByRole("heading", { name: "Done" })).toHaveCount(0);
    await expect(
      controlPanel.getByRole("button", { name: "Choose a file", exact: true })
    ).toBeVisible();

    await controlPanel.screenshot({
      path: path.join(GOAL_EVIDENCE_DIR, "transcribe-cancelled.png"),
      fullPage: true,
      animations: "disabled",
    });

    // The engine survives: a short file transcribes immediately afterwards, on
    // the same server process. Both halves matter — a pid that never changed
    // over a server that stopped answering would be worthless.
    await controlPanel.locator('input[type="file"]').setInputFiles(BANANA_WAV);
    await expect(controlPanel.getByRole("heading", { name: "Done" })).toBeVisible({
      timeout: 120_000,
    });
    await expect(controlPanel.locator("textarea[readonly]")).toContainText(/banana/i);

    expect(await readWhisperPid(controlPanel)).toBe(pidDuringRun);
  });

  test("a cancelled run's result never lands on the page", async ({ controlPanel }) => {
    expect(fs.existsSync(BASE_MODEL)).toBe(true);

    await prepareForLocalTranscription(controlPanel);
    await openTranscribePage(controlPanel);

    await controlPanel.locator('input[type="file"]').setInputFiles(INTERVIEW_WAV);
    const cancelButton = controlPanel.getByRole("button", { name: "Cancel", exact: true });
    await expect(cancelButton).toBeVisible({ timeout: 30_000 });
    await cancelButton.click();
    await expect(controlPanel.getByRole("heading", { name: "Cancelled" })).toBeVisible({
      timeout: 30_000,
    });

    // Well past the ~3s this decode takes when it is allowed to finish. If a
    // late result could still overwrite the page, it would have by now.
    await controlPanel.waitForTimeout(8_000);
    await expect(controlPanel.getByRole("heading", { name: "Cancelled" })).toBeVisible();
    await expect(controlPanel.locator("textarea[readonly]")).toHaveCount(0);
  });
});
