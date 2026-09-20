import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";

const root = path.resolve(__dirname, "../..");
const phase = process.env.PT_SPEAKER_CAPTURE_PHASE || "after";
const evidenceDir = process.env.PT_SPEAKER_EVIDENCE_DIR;

test("multilingual speaker settings and short replies", async ({
  electronApp,
  controlPanel,
}, info) => {
  const { assignSpeakersToSegments } = require(`${root}/src/helpers/diarizationMerge`);
  const { formatTranscript } = require(`${root}/src/helpers/transcriptFormatter`);
  const words = [
    { start: 0, end: 1, word: " Kan" },
    { start: 1, end: 2, word: " vi" },
    { start: 2, end: 3, word: " starte?" },
    { start: 3, end: 4, word: " Ja." },
    { start: 4, end: 5, word: " Ja." },
    { start: 5, end: 6, word: " Let's" },
    { start: 6, end: 7, word: " begin." },
  ];
  const segments = assignSpeakersToSegments(
    [{ start: 0, end: 7, text: " Kan vi starte? Ja. Ja. Let's begin.", words }],
    [
      { start: 0, end: 3, speaker: "SPEAKER_00" },
      { start: 3, end: 4, speaker: "SPEAKER_01" },
      { start: 4, end: 5, speaker: "SPEAKER_02" },
      { start: 5, end: 7, speaker: "SPEAKER_00" },
    ]
  );
  const result = {
    success: true,
    ...formatTranscript({ segments }, "speakers"),
    speakerDetectionActive: true,
    speakerDetectionMode: "local-diarization",
  };
  await electronApp.evaluate(({ ipcMain }, result) => {
    ipcMain.removeHandler("check-diarization-model-status");
    ipcMain.handle("check-diarization-model-status", () => ({ ready: false }));
    ipcMain.removeHandler("check-model-status");
    ipcMain.handle("check-model-status", () => ({ downloaded: true }));
    ipcMain.removeHandler("transcribe-file-v2");
    ipcMain.handle("transcribe-file-v2", () => result);
  }, result);
  await controlPanel.evaluate(() => {
    localStorage.setItem("useLocalWhisper", "true");
    localStorage.setItem("whisperModel", "base");
    localStorage.setItem("fileTranscriptionLanguage", "auto");
    localStorage.setItem("fileTranscriptionSpeakerDetection", "true");
  });
  await controlPanel.reload({ waitUntil: "domcontentloaded" });
  await controlPanel.getByRole("button", { name: "Transcribe File", exact: true }).click();
  const capture = async (name: string) => {
    const dir = evidenceDir || info.outputDir;
    fs.mkdirSync(dir, { recursive: true });
    await controlPanel.screenshot({ path: path.join(dir, `${phase}-${name}.png`), fullPage: true });
  };
  await expect(controlPanel.getByText("Number of speakers", { exact: true })).toBeVisible();
  await capture("auto-language");
  if (phase !== "before") {
    await expect(
      controlPanel.getByText("Speaker models not yet downloaded.", { exact: false })
    ).toBeVisible();
    await controlPanel.getByRole("button", { name: "Download now", exact: true }).click();
    await expect(
      controlPanel.getByRole("heading", { name: "Download speaker models" })
    ).toBeVisible();
    await capture("download-dialog");
    await controlPanel.locator("main").getByRole("button", { name: "Close", exact: true }).click();
  }
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("check-diarization-model-status");
    ipcMain.handle("check-diarization-model-status", () => ({ ready: true }));
  });
  await controlPanel.reload({ waitUntil: "domcontentloaded" });
  await controlPanel.getByRole("button", { name: "Transcribe File", exact: true }).click();
  await expect(controlPanel.getByText(/Using multilingual speaker detection/)).toBeVisible();
  await capture("ready");
  if (phase !== "before") {
    await controlPanel.getByRole("combobox").click();
    await expect(
      controlPanel.getByRole("option", { name: "10 speakers", exact: true })
    ).toBeVisible();
    await capture("speaker-count-open");
    await controlPanel.getByRole("option", { name: "8 speakers", exact: true }).click();
    await expect(controlPanel.getByRole("combobox")).toHaveText("8 speakers");
    await controlPanel.reload({ waitUntil: "domcontentloaded" });
    await controlPanel.getByRole("button", { name: "Transcribe File", exact: true }).click();
    await expect(controlPanel.getByRole("combobox")).toHaveText("8 speakers");
    await controlPanel.getByRole("combobox").click();
    await controlPanel.getByRole("option", { name: "1 speaker", exact: true }).click();
    await expect(controlPanel.getByRole("combobox")).toHaveText("1 speaker");
    await controlPanel.getByRole("combobox").click();
    await controlPanel.getByRole("option", { name: "Auto (up to 6)", exact: true }).click();
  }
  await controlPanel.locator('input[type="file"]').setInputFiles({
    name: "Danish-and-English-example.wav",
    mimeType: "audio/wav",
    buffer: Buffer.from("test fixture"),
  });
  await expect(controlPanel.getByRole("heading", { name: "Done" })).toBeVisible();
  await controlPanel.locator("textarea[readonly]").scrollIntoViewIfNeeded();
  await capture("short-replies");
  if (phase !== "before") {
    const transcript = await controlPanel.locator("textarea[readonly]").inputValue();
    expect(transcript).toContain("Speaker 1: Kan vi starte?");
    expect(transcript).toContain("Speaker 2: Ja.");
    expect(transcript).toContain("Speaker 3: Ja.");
    expect(transcript).toContain("Speaker 1: Let's begin.");
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("check-diarization-model-status");
      ipcMain.handle("check-diarization-model-status", () => ({ ready: false }));
    });
    await controlPanel.evaluate(() => localStorage.setItem("fileTranscriptionLanguage", "en"));
    await controlPanel.reload({ waitUntil: "domcontentloaded" });
    await controlPanel.getByRole("button", { name: "Transcribe File", exact: true }).click();
    await expect(
      controlPanel.getByText(/English turn detection alternates between two labels/)
    ).toBeVisible();
    await expect(controlPanel.getByRole("combobox")).toBeDisabled();
    await capture("english-fallback");
    await controlPanel
      .getByRole("button", { name: "Download multilingual speaker models" })
      .click();
    await expect(
      controlPanel.getByRole("heading", { name: "Download speaker models" })
    ).toBeVisible();
    await controlPanel.locator("main").getByRole("button", { name: "Close", exact: true }).click();
    await controlPanel.getByRole("checkbox", { name: /^Speaker labels/ }).uncheck();
    await expect(controlPanel.getByText("Number of speakers", { exact: true })).toHaveCount(0);
    await capture("labels-off");
    await controlPanel.getByRole("button", { name: "Settings Hide", exact: true }).click();
    await capture("settings-closed");
  }
});

for (const sample of [
  { name: "interview", count: 3 },
  { name: "control", count: 1 },
]) {
  test(`real local ${sample.name} reports its speakers`, async ({ controlPanel }, info) => {
    test.skip(
      process.env.PT_REAL_SPEAKERS !== "1",
      "Requires installed local Whisper and diarization models"
    );
    test.setTimeout(300_000);
    await controlPanel.evaluate(() => {
      localStorage.setItem("useLocalWhisper", "true");
      localStorage.setItem("whisperModel", "base");
      localStorage.setItem("fileTranscriptionLanguage", "en");
      localStorage.setItem("fileTranscriptionSpeakerDetection", "true");
    });
    await controlPanel.reload({ waitUntil: "domcontentloaded" });
    await controlPanel.getByRole("button", { name: "Transcribe File", exact: true }).click();
    await controlPanel
      .locator('input[type="file"]')
      .setInputFiles(path.join(root, `tests/fixtures/multispeaker/${sample.name}.wav`));
    await expect(controlPanel.getByRole("heading", { name: "Done" })).toBeVisible({
      timeout: 240_000,
    });
    const transcript = await controlPanel.locator("textarea[readonly]").inputValue();
    await expect(
      controlPanel
        .getByText(sample.count === 1 ? "1 speaker" : "3 speakers", { exact: true })
        .first()
    ).toBeVisible();
    if (sample.count > 1) {
      expect(transcript).toContain("Speaker 1");
      expect(transcript).toContain("Speaker 2");
      expect(transcript).toContain("Speaker 3");
    }
    expect(transcript).not.toContain("Unknown speaker");
    const dir = evidenceDir || info.outputDir;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${phase}-real-${sample.name}.txt`), transcript);
    await controlPanel.locator("textarea[readonly]").scrollIntoViewIfNeeded();
    await controlPanel.screenshot({
      path: path.join(dir, `${phase}-real-${sample.name}.png`),
      fullPage: true,
    });
  });
}
