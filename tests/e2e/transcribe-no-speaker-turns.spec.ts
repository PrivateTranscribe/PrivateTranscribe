import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";
import { evidenceDir } from "./fixtures/evidence";

/**
 * What the page says about speakers — audit F8.
 *
 * On the committed three-voice fixture, with tinydiarize genuinely enabled
 * (whisper-server's own startup line reported `tdrz = 1`), whisper.cpp emits
 * ZERO [SPEAKER_TURN] markers — the transcribe-speaker-turns gate measured
 * recall 0.0000 twice. The transcript therefore carries one placeholder speaker,
 * and the page rendered a confident "1 speaker" badge over audio with three.
 * The same badge appeared when speaker labels were switched off entirely, where
 * the count is nothing but the placeholder label counting itself.
 *
 * The result carries `speakerDetectionActive` alongside the count, so the two
 * cases are distinguishable and the page now reads both: nothing at all when
 * detection never ran, and what was actually found when it did.
 *
 * Real audio, real CPU decode. Which engine runs is pinned rather than
 * inherited: the throwaway home holds exactly two whisper models (hardlinked
 * from this machine, nothing downloaded), and the sherpa diarization models are
 * pointed at an empty directory. That is the state of any user who has not
 * taken the separate 150 MB download — and it is the state the audit measured.
 * With sherpa installed this same fixture is labelled correctly as 3 speakers,
 * which is why the badge has to distinguish the cases instead of guessing.
 */
const EMPTY_DIARIZATION_DIR = path.join(os.tmpdir(), "pt-e2e-empty-diarization-models");

test.use({
  appEnv: {
    WHISPER_FORCE_CPU: "true",
    PRIVATETRANSCRIBE_DIARIZATION_MODELS_DIR: EMPTY_DIARIZATION_DIR,
  },
  useThrowawayHome: true,
  seedRealWhisperModels: ["base", "small-en-tdrz"],
});

const INTERVIEW_WAV = path.resolve(__dirname, "..", "fixtures", "multispeaker", "interview.wav");
const GOAL_EVIDENCE_DIR = evidenceDir("transcribe-no-speaker-turns");

async function prepare(page: Page, speakerLabels: boolean): Promise<void> {
  await page.evaluate((labels) => {
    localStorage.setItem("useLocalWhisper", "true");
    localStorage.setItem("whisperModel", "base");
    localStorage.setItem("fileTranscriptionLanguage", "en");
    localStorage.setItem("whisperForceCpu", "true");
    localStorage.setItem("fileTranscriptionSpeakerDetection", labels ? "true" : "false");
    localStorage.setItem(
      "fileTranscriptionSpeakerDetectionMode",
      labels ? "tiny-diarize-en" : "off"
    );
  }, speakerLabels);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.evaluate(() =>
    (window as unknown as { electronAPI: any }).electronAPI.setWhisperForceCpu(true)
  );
  await page.getByRole("button", { name: "Transcribe File", exact: true }).click();
}

test.describe("Transcribe page speaker reporting", () => {
  test("says no turns were found instead of claiming one speaker", async ({ controlPanel }) => {
    fs.mkdirSync(GOAL_EVIDENCE_DIR, { recursive: true });

    await prepare(controlPanel, true);
    await controlPanel.locator('input[type="file"]').setInputFiles(INTERVIEW_WAV);

    await expect(controlPanel.getByRole("heading", { name: "Done" })).toBeVisible({
      timeout: 300_000,
    });
    await expect(controlPanel.locator("textarea[readonly]")).not.toBeEmpty();

    // The detector ran and found no speaker change. That is what it says, in
    // both places the result appears. Only those are searched for a count: the
    // speaker-count picker in the settings above lists "1 speaker" to
    // "10 speakers" as choices, which claims nothing about this file.
    const doneCard = controlPanel
      .getByRole("button")
      .filter({ has: controlPanel.getByRole("heading", { name: "Done" }) });
    const transcript = controlPanel
      .locator("section")
      .filter({ has: controlPanel.locator("textarea[readonly]") });
    for (const result of [doneCard, transcript]) {
      await expect(result.getByText("No speaker turns found")).toBeVisible();
      await expect(result.getByText(/\b\d+ speakers?\b/)).toHaveCount(0);
    }

    await controlPanel.screenshot({
      path: path.join(GOAL_EVIDENCE_DIR, "transcribe-no-speakers.png"),
      fullPage: true,
      animations: "disabled",
    });
  });

  test("says nothing about speakers when detection never ran", async ({ controlPanel }) => {
    await prepare(controlPanel, false);
    await controlPanel.locator('input[type="file"]').setInputFiles(INTERVIEW_WAV);

    await expect(controlPanel.getByRole("heading", { name: "Done" })).toBeVisible({
      timeout: 300_000,
    });

    // Speaker labels are off, so every segment carries the same placeholder
    // label. Counting it produced the old "1 speaker" badge; there is nothing
    // here to report either way.
    await expect(controlPanel.getByText(/\b\d+ speakers?\b/)).toHaveCount(0);
    await expect(controlPanel.getByText("No speaker turns found")).toHaveCount(0);
  });
});
