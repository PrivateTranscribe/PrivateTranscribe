import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";

/**
 * A forced wrong language is surfaced, not swallowed — audit F5.
 *
 * The English control fixture forced to Danish comes back as fluent Danish that
 * says nothing the speaker said, and the app reported it as a plain success. The
 * evidence was already in the response the app parses: whisper-server returned
 * `detected_language: "english"` at 0.9965 on that very run, and the parser
 * dropped it.
 *
 * This drives the real thing end to end — real decode, CPU, own port — and
 * asserts the notice appears with the engine's own numbers, that the offered
 * re-run actually re-decodes in the detected language (checked at the wire, not
 * in the UI), and that the notice does not appear when the language is right.
 *
 * What is deliberately NOT asserted: any auto-switching. The user's explicit
 * choice stands until they press the button.
 */
test.use({ appEnv: { WHISPER_FORCE_CPU: "true" } });

const CONTROL_WAV = path.resolve(__dirname, "..", "fixtures", "multispeaker", "control.wav");
const BASE_MODEL = path.join(
  os.homedir(),
  ".cache",
  "PrivateTranscribe",
  "whisper-models",
  "ggml-base.bin"
);
const GOAL_EVIDENCE_DIR = path.resolve(__dirname, "..", "..", "docs", "goal-evidence");

type InferenceRequest = { language: string | null; detectLanguage: boolean; fileMode: boolean };

async function readInferenceRequests(page: Page): Promise<InferenceRequest[]> {
  const diagnostics = await page.evaluate(
    () => (window as unknown as { electronAPI: any }).electronAPI.getAudioDiagnostics()
  );
  return diagnostics?.recentInferenceRequests ?? [];
}

async function prepareForLocalTranscription(page: Page, language: string): Promise<void> {
  await page.evaluate((lang) => {
    localStorage.setItem("useLocalWhisper", "true");
    localStorage.setItem("whisperModel", "base");
    localStorage.setItem("fileTranscriptionSpeakerDetection", "false");
    localStorage.setItem("fileTranscriptionLanguage", lang);
    localStorage.setItem("whisperForceCpu", "true");
  }, language);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.evaluate(() =>
    (window as unknown as { electronAPI: any }).electronAPI.setWhisperForceCpu(true)
  );
}

async function openTranscribePage(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Transcribe File", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Transcribe", exact: true })).toBeVisible();
}

test.describe("Transcribe page wrong-language notice", () => {
  test("warns when the engine heard a different language, and offers the re-run", async ({
    controlPanel,
  }) => {
    expect(
      fs.existsSync(BASE_MODEL),
      `ggml-base.bin is not installed at ${BASE_MODEL} — download it before running this spec`
    ).toBe(true);

    // Danish forced onto English audio: the exact case the audit measured.
    await prepareForLocalTranscription(controlPanel, "da");
    await openTranscribePage(controlPanel);
    await expect(controlPanel.locator('button[aria-haspopup="listbox"]').first()).toHaveText(
      "Danish"
    );

    await controlPanel.locator('input[type="file"]').setInputFiles(CONTROL_WAV);
    await expect(controlPanel.getByRole("heading", { name: "Done" })).toBeVisible({
      timeout: 180_000,
    });

    // The engine's own verdict, in the page's own words.
    const notice = controlPanel.getByText("This audio sounds like English, not Danish");
    await expect(notice).toBeVisible();
    await expect(
      controlPanel.getByText(/Whisper detected English with 99\.\d% confidence/)
    ).toBeVisible();

    // The page scrolls inside its own shell, so fullPage still captures one
    // viewport — bring the notice into it, and let the success toast clear so
    // the evidence shows the page rather than a banner over it.
    await notice.scrollIntoViewIfNeeded();
    await expect(controlPanel.getByText("Transcription complete")).toHaveCount(0, {
      timeout: 20_000,
    });

    fs.mkdirSync(GOAL_EVIDENCE_DIR, { recursive: true });
    await controlPanel.screenshot({
      path: path.join(GOAL_EVIDENCE_DIR, "transcribe-language-mismatch.png"),
      animations: "disabled",
    });

    // The transcript is still shown: the result is not blocked, only labelled.
    await expect(controlPanel.locator("textarea[readonly]")).toBeVisible();

    const before = (await readInferenceRequests(controlPanel)).length;
    await controlPanel.getByRole("button", { name: "Transcribe again in English" }).click();
    await expect(controlPanel.getByRole("heading", { name: "Done" })).toBeVisible({
      timeout: 180_000,
    });

    // Wire-level, not UI-level: the re-run really asked the engine for English.
    const rerun = (await readInferenceRequests(controlPanel)).slice(before);
    expect(rerun.length).toBeGreaterThan(0);
    for (const request of rerun) {
      expect(request.language).toBe("en");
      expect(request.fileMode).toBe(true);
    }

    // Agreement now, so nothing to warn about — and the picker shows the
    // language the user just chose by clicking.
    await expect(controlPanel.getByText(/This audio sounds like/)).toHaveCount(0);
    await expect(controlPanel.locator('button[aria-haspopup="listbox"]').first()).toHaveText(
      "English"
    );
    await expect(controlPanel.locator("textarea[readonly]")).toContainText(/lecture notes/i);
  });

  test("says nothing when the picked language is the one that was spoken", async ({
    controlPanel,
  }) => {
    expect(fs.existsSync(BASE_MODEL)).toBe(true);

    await prepareForLocalTranscription(controlPanel, "en");
    await openTranscribePage(controlPanel);

    await controlPanel.locator('input[type="file"]').setInputFiles(CONTROL_WAV);
    await expect(controlPanel.getByRole("heading", { name: "Done" })).toBeVisible({
      timeout: 180_000,
    });

    await expect(controlPanel.getByText(/This audio sounds like/)).toHaveCount(0);
  });
});
