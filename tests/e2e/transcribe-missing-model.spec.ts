import path from "node:path";
import { expect, test } from "./fixtures/electron-app";

/**
 * Repro for docs/TRANSCRIBE_AUDIT.md F7, observed at the UI layer by dropping
 * the committed control fixture on the real Transcribe page with no Whisper
 * model on disk.
 *
 * `useThrowawayHome` points the app's model cache at an empty directory, so the
 * result does not depend on what the developer running this happens to have in
 * ~/.cache. Nothing is decoded here — the pipeline refuses before it starts a
 * server — so the run is fast and never touches the GPU or the user's own
 * whisper-server.
 */
test.use({ useThrowawayHome: true });

const CONTROL_WAV = path.resolve(
  __dirname,
  "..",
  "fixtures",
  "multispeaker",
  "control.wav"
);

async function uploadControlWav(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    localStorage.setItem("useLocalWhisper", "true");
    localStorage.setItem("whisperModel", "base");
    localStorage.setItem("fileTranscriptionLanguage", "en");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Transcribe File", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles(CONTROL_WAV);
}

test.describe("Transcribe page with no model installed", () => {
  test("says the model is missing rather than blaming the file", async ({ controlPanel }) => {
    await uploadControlWav(controlPanel);

    await expect(
      controlPanel.getByRole("heading", { name: "Transcription failed" })
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      controlPanel.getByText(/Whisper model "base" not downloaded/).first()
    ).toBeVisible();

    // The one action on offer, and it cannot help: no file transcribes until
    // the model is on disk. F7 in the audit.
    await expect(
      controlPanel.getByRole("button", { name: "Try another file", exact: true })
    ).toBeVisible();

    await controlPanel.screenshot({
      path: "test-results/e2e/transcribe-missing-model.png",
      fullPage: true,
    });
  });

  /**
   * The page's answer to a missing model is a button reading "Try another
   * file". No other file will transcribe either, and the page's own Settings
   * panel holds no model picker, so the offered action cannot lead anywhere.
   *
   * Expected-failure: this documents the gap without breaking the suite. When
   * it starts failing the gap is closed — remove `test.fail()`, not the
   * assertion.
   */
  test("offers a way to install the missing model", async ({ controlPanel }) => {
    test.fail();
    await uploadControlWav(controlPanel);

    await expect(
      controlPanel.getByRole("heading", { name: "Transcription failed" })
    ).toBeVisible({ timeout: 30_000 });
    // A real <button>, not the dropzone container — that div also carries
    // role="button", and the failure text inside it contains the word "model".
    await expect(controlPanel.locator("button").filter({ hasText: /model/i })).toBeVisible({
      timeout: 5_000,
    });
  });
});
