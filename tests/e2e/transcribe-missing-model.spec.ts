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

    // "Try another file" used to be the only thing on offer here, and it cannot
    // help: no file transcribes until the model is on disk. F7 in the audit.
    await expect(
      controlPanel.getByRole("button", { name: "Try another file", exact: true })
    ).toHaveCount(0);

    await controlPanel.screenshot({
      path: "test-results/e2e/transcribe-missing-model.png",
      fullPage: true,
    });
    await controlPanel.screenshot({
      path: "docs/goal-evidence/transcribe-missing-model-cta.png",
      fullPage: true,
    });
  });

  /**
   * The offered recovery has to be the one that can end this failure. Models
   * are installed from Settings → Transcription, which is a different page —
   * so the assertion follows the button there and checks the model picker is
   * really on screen, rather than trusting a label.
   */
  test("offers a way to install the missing model", async ({ controlPanel }) => {
    await uploadControlWav(controlPanel);

    await expect(controlPanel.getByRole("heading", { name: "Transcription failed" })).toBeVisible({
      timeout: 30_000,
    });
    // A real <button>, not the dropzone container — that div also carries
    // role="button", and the failure text inside it contains the word "model".
    const modelButton = controlPanel.locator("button").filter({ hasText: /model/i });
    await expect(modelButton).toBeVisible({ timeout: 5_000 });

    await modelButton.click();

    await expect(controlPanel.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(controlPanel.getByText("Speech Recognition")).toBeVisible();
    // The picker that can put the model on disk, on the tab the button chose.
    await expect(controlPanel.getByText(/Local|Whisper/).first()).toBeVisible();

    await controlPanel.screenshot({
      path: "docs/goal-evidence/transcribe-missing-model-destination.png",
      fullPage: true,
    });
  });
});
