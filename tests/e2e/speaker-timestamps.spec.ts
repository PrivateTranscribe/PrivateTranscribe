import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";

/**
 * With speaker labels on, every speaker turn on the Transcribe page starts with
 * the time it started, and the same text reaches Copy and the TXT download.
 *
 * The first test drives the page with the real formatter's output and needs
 * no models. The second decodes a file longer than an hour with the real local
 * Whisper and speaker models (PT_REAL_SPEAKERS=1), on the CPU so it never
 * contends with a CUDA engine or the installed app's own whisper-server.
 */
test.use({ appEnv: { WHISPER_FORCE_CPU: "true" } });

const root = path.resolve(__dirname, "../..");
const fixtures = path.join(root, "tests/fixtures/multispeaker");
const phase = process.env.PT_SPEAKER_CAPTURE_PHASE || "after";
const evidenceDir = process.env.PT_SPEAKER_EVIDENCE_DIR;

type Utterance = { speaker: string; text: string; startSec: number; endSec: number };
const utterances = (name: string): Utterance[] =>
  JSON.parse(fs.readFileSync(path.join(fixtures, `${name}.truth.json`), "utf8")).utterances;

const LINE = /^\[(\d{2}):(\d{2}):(\d{2})\] (Speaker \d+|Unknown speaker): (.+)$/;

function parseLines(transcript: string) {
  return transcript.split("\n").map((line) => {
    const match = line.match(LINE);
    expect(match, `not a stamped speaker line: ${line}`).not.toBeNull();
    const [, h, m, s, speaker, text] = match!;
    return { seconds: Number(h) * 3600 + Number(m) * 60 + Number(s), speaker, text };
  });
}

async function openTranscribePage(page: Page) {
  await page.evaluate(() => {
    localStorage.setItem("useLocalWhisper", "true");
    localStorage.setItem("whisperModel", "base");
    localStorage.setItem("fileTranscriptionLanguage", "en");
    localStorage.setItem("fileTranscriptionSpeakerDetection", "true");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Transcribe File", exact: true }).click();
}

/**
 * Presses Copy, TXT and SRT and returns what each would have handed over. The
 * clipboard and the download are caught inside the page, so a run never
 * overwrites the user's clipboard or opens a save dialog.
 */
async function copyAndDownload(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.__copied = [];
    w.__downloads = [];
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async (text: string) => {
        w.__copied.push(text);
      },
    });
    const createObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob: Blob) => {
      w.__downloads.push({ blob });
      return createObjectURL(blob);
    };
    HTMLAnchorElement.prototype.click = function () {
      w.__downloads[w.__downloads.length - 1].name = this.download;
    };
  });
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await page.getByRole("button", { name: "TXT", exact: true }).click();
  await page.getByRole("button", { name: "SRT", exact: true }).click();
  return page.evaluate(async () => {
    const w = window as any;
    const downloads = await Promise.all(
      w.__downloads.map(async (d: any) => ({ name: d.name, text: await d.blob.text() }))
    );
    return { copied: w.__copied as string[], downloads };
  });
}

async function capture(page: Page, name: string, outputDir: string, transcript: string) {
  const dir = evidenceDir || outputDir;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${phase}-${name}.txt`), transcript);
  // Toasts sit over the transcript's corner; the picture is of the transcript.
  await expect(page.locator("[data-overlay-toast]")).toHaveCount(0, { timeout: 15_000 });
  const panel = page.locator("section", { hasText: "Transcript" }).last();
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: path.join(dir, `${phase}-${name}.png`) });
}

test("Copy and TXT carry the times of a speaker-labelled transcript", async ({
  electronApp,
  controlPanel,
}, info) => {
  const { formatTranscript } = require(`${root}/src/helpers/transcriptFormatter`);
  const names: Record<string, string> = {
    HOST: "Speaker 1",
    GUEST_A: "Speaker 2",
    GUEST_B: "Speaker 3",
  };
  const interview = utterances("interview");
  // What the main process returns for the interview fixture once its speakers
  // are found.
  const result = {
    success: true,
    ...formatTranscript(
      {
        segments: interview.map((u) => ({
          start: u.startSec,
          end: u.endSec,
          text: ` ${u.text}`,
          speaker: names[u.speaker],
        })),
      },
      "speakers"
    ),
    speakerDetectionActive: true,
    speakerDetectionMode: "local-diarization",
  };
  await electronApp.evaluate(({ ipcMain }, result) => {
    ipcMain.removeHandler("check-diarization-model-status");
    ipcMain.handle("check-diarization-model-status", () => ({ ready: true }));
    ipcMain.removeHandler("check-model-status");
    ipcMain.handle("check-model-status", () => ({ downloaded: true }));
    ipcMain.removeHandler("transcribe-file-v2");
    ipcMain.handle("transcribe-file-v2", () => result);
  }, result);
  await openTranscribePage(controlPanel);
  await controlPanel.locator('input[type="file"]').setInputFiles({
    name: "interview.wav",
    mimeType: "audio/wav",
    buffer: Buffer.from("test fixture"),
  });
  await expect(controlPanel.getByRole("heading", { name: "Done" })).toBeVisible();

  const transcript = await controlPanel.locator("textarea[readonly]").inputValue();
  expect(transcript.split("\n").slice(0, 3)).toEqual([
    "[00:00:00] Speaker 1: Thanks for joining me. I want to hear how you both actually take notes in lectures.",
    "[00:00:05] Speaker 2: Happy to be here. It started because my handwriting is slow and my professor talks fast.",
    "[00:00:12] Speaker 1: So you record the whole lecture?",
  ]);
  const lines = parseLines(transcript);
  expect(lines).toHaveLength(interview.length);

  // The word count is the words that were said: no times, no speaker names.
  const spoken = interview.reduce((total, u) => total + u.text.split(/\s+/).length, 0);
  await expect(controlPanel.getByText(`${spoken} words`, { exact: true })).toBeVisible();

  const { copied, downloads } = await copyAndDownload(controlPanel);
  expect(copied).toEqual([transcript]);
  expect(downloads).toEqual([
    { name: "interview.txt", text: transcript },
    { name: "interview.srt", text: result.srt },
  ]);
  // The subtitle file keeps its own cue times and speaker names.
  expect(result.srt).toMatch(/^1\n00:00:00,000 --> 00:00:05,\d{3}\nSpeaker 1: Thanks/);
  expect(result.srt).not.toMatch(/^\[/m);

  await capture(controlPanel, "speaker-timestamps", info.outputDir, transcript);
});

test("a recording over an hour keeps the true time on every speaker turn", async ({
  controlPanel,
}, info) => {
  test.skip(
    process.env.PT_REAL_SPEAKERS !== "1",
    "Requires installed local Whisper base and speaker models"
  );
  test.setTimeout(900_000);

  // One voice for 94 s (the control fixture twice), silence, then the
  // three-voice interview from 59:30, so the conversation runs past the hour.
  // The fixtures are 16 kHz mono 16-bit PCM with a 44-byte header.
  const BYTES_PER_SECOND = 32000;
  const INTERVIEW_AT = 3570;
  const control = fs.readFileSync(path.join(fixtures, "control.wav")).subarray(44);
  const interview = fs.readFileSync(path.join(fixtures, "interview.wav")).subarray(44);
  const silence = Buffer.alloc(INTERVIEW_AT * BYTES_PER_SECOND - 2 * control.length);
  const data = Buffer.concat([control, control, silence, interview]);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(BYTES_PER_SECOND, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  const file = info.outputPath("seminar-over-an-hour.wav");
  fs.writeFileSync(file, Buffer.concat([header, data]));
  const controlSeconds = control.length / BYTES_PER_SECOND;

  await openTranscribePage(controlPanel);
  try {
    await controlPanel.locator('input[type="file"]').setInputFiles(file);
    await expect(controlPanel.getByRole("heading", { name: "Done" })).toBeVisible({
      timeout: 840_000,
    });
  } finally {
    // 117 MB of mostly silence; the transcript is all this test reads.
    fs.rmSync(file, { force: true });
  }

  const transcript = await controlPanel.locator("textarea[readonly]").inputValue();
  const lines = parseLines(transcript);
  const stamps = lines.map((line) => line.seconds);
  expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);

  // One voice for 94 s still gets a new stamped line after about a minute, at
  // the start of a sentence: the line before it ends one.
  const monologue = lines.filter((line) => line.seconds < 2 * controlSeconds);
  expect(monologue[0].seconds).toBe(0);
  expect(monologue.length).toBeGreaterThanOrEqual(2);
  for (let i = 1; i < monologue.length; i++) {
    expect(monologue[i].seconds - monologue[i - 1].seconds).toBeGreaterThanOrEqual(60);
    expect(monologue[i].seconds - monologue[i - 1].seconds).toBeLessThanOrEqual(95);
    expect(monologue[i - 1].text).toMatch(/[.!?]$/);
  }
  // Nothing is stamped in the silence, and the voice that comes back after it
  // is stamped with the time it came back, not the time before the break.
  expect(stamps.filter((s) => s > 2 * controlSeconds + 1 && s < INTERVIEW_AT - 1)).toEqual([]);
  const afterBreak = stamps.find((s) => s >= INTERVIEW_AT - 1)!;
  expect(afterBreak).toBeGreaterThanOrEqual(INTERVIEW_AT - 1);
  expect(afterBreak).toBeLessThanOrEqual(INTERVIEW_AT + 1);
  expect(stamps.at(-1)!).toBeGreaterThan(3600);

  // Each line's time falls inside the reference utterance its first words come
  // from. Lines whose first words Whisper heard differently are not matched.
  const reference = [
    ...utterances("control").map((u) => ({ ...u, offset: 0 })),
    ...utterances("control").map((u) => ({ ...u, offset: controlSeconds })),
    ...utterances("interview").map((u) => ({ ...u, offset: INTERVIEW_AT })),
  ];
  const words = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}' ]+/gu, " ")
      .split(/\s+/)
      .filter(Boolean);
  let matched = 0;
  for (const line of lines) {
    if (words(line.text).length < 3) continue;
    const opening = words(line.text).slice(0, 3).join(" ");
    const sources = reference.filter((u) =>
      ` ${words(u.text).join(" ")} `.includes(` ${opening} `)
    );
    if (sources.length === 0) continue;
    matched += 1;
    expect(
      sources.some(
        (u) => line.seconds >= u.startSec + u.offset - 2 && line.seconds <= u.endSec + u.offset + 1
      ),
      `${line.seconds}s is outside every utterance that contains "${opening}"`
    ).toBe(true);
  }
  expect(matched / lines.length).toBeGreaterThanOrEqual(0.7);

  const { copied, downloads } = await copyAndDownload(controlPanel);
  expect(copied).toEqual([transcript]);
  expect(downloads[0]).toEqual({ name: "seminar-over-an-hour.txt", text: transcript });

  // Grown to its text, the box shows the minute break, the silence and the
  // hour in one picture. It is resizable, so a user can drag it this tall.
  await controlPanel.locator("textarea[readonly]").evaluate((element) => {
    element.style.height = `${element.scrollHeight + 4}px`;
  });
  await capture(controlPanel, "real-over-an-hour", info.outputDir, transcript);
});
