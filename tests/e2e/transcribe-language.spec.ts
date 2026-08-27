import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";

/**
 * The Transcribe page's language control, checked at both ends: the picker the
 * user touches, and the instruction whisper-server is actually handed.
 *
 * The second half is the point. A language dropdown that looks right and writes
 * localStorage proves nothing about the decode, so every language assertion
 * here reads the main process's own record of what left it — never the UI, and
 * never a value the renderer supplied.
 *
 * Two records exist because whisper-server is instructed in two places:
 *
 * - `lastSpawn.args` is the server's command line. Its `--language` is a
 *   startup default and is always `auto`; the app does not pass a language to
 *   `start()`, and a warm server is reused across language changes anyway.
 * - `recentInferenceRequests` is the multipart body of each `/inference` POST,
 *   recorded where the form is built. This is where the chosen language really
 *   travels, so this is what the per-language assertions read.
 *
 * Like the timestamped-output spec, this decodes real audio: the committed
 * 46.8s control fixture with the machine's own ggml-base.bin. The server it
 * spawns is its own, on a free port, so it never touches the whisper-server the
 * installed app may be running — and it is pinned to the CPU engine, which
 * takes more than the WHISPER_FORCE_CPU env var alone (see forceCpuEngine).
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

/** Every option the shared LanguageSelector offers: 57 languages plus auto. */
const LANGUAGE_OPTION_COUNT = 58;

type InferenceRequest = {
  language: string | null;
  detectLanguage: boolean;
  translate: boolean;
  fileMode: boolean;
  chunkIndex: number;
  chunkCount: number;
  pid: number | null;
};

type WhisperDiagnostics = {
  lastSpawn: { binary: string; args: string[]; pid: number | null; forceCpu: boolean } | null;
  recentInferenceRequests: InferenceRequest[];
};

async function readWhisperDiagnostics(page: Page): Promise<WhisperDiagnostics> {
  return page.evaluate(
    () => (window as unknown as { electronAPI: any }).electronAPI.getAudioDiagnostics()
  );
}

async function openTranscribePage(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Transcribe File", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Transcribe", exact: true })).toBeVisible();
}

/** The shared LanguageSelector's trigger — the only listbox button on this page. */
const languageTrigger = (page: Page) => page.locator('button[aria-haspopup="listbox"]').first();

async function selectLanguage(page: Page, label: string): Promise<void> {
  await languageTrigger(page).click();
  await page.getByPlaceholder("Search...").fill(label);
  await page.getByRole("option", { name: label, exact: true }).click();
  await expect(languageTrigger(page)).toHaveText(label);
}

/**
 * Run the control fixture through the page and hand back only the requests this
 * run produced, so a warm server's earlier requests cannot be mistaken for it.
 */
async function transcribeControlFile(page: Page): Promise<InferenceRequest[]> {
  const seen = (await readWhisperDiagnostics(page)).recentInferenceRequests.length;

  await page.locator('input[type="file"]').setInputFiles(CONTROL_WAV);
  await expect(page.getByRole("heading", { name: "Done" })).toBeVisible({ timeout: 180_000 });

  const diagnostics = await readWhisperDiagnostics(page);
  return diagnostics.recentInferenceRequests.slice(seen);
}

/**
 * Pin the run to the CPU engine and wait for the pin to land.
 *
 * WHISPER_FORCE_CPU alone is not enough: useSettings pushes the renderer's
 * stored `whisperForceCpu` down over IPC on mount, which clears the env-set
 * flag again. Writing the setting first and then awaiting the IPC directly
 * makes the CPU choice deterministic rather than a race with a React effect —
 * `--no-gpu` on the spawn record below is what proves it took.
 */
async function forceCpuEngine(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.setItem("whisperForceCpu", "true"));
  await page.evaluate(() =>
    (window as unknown as { electronAPI: any }).electronAPI.setWhisperForceCpu(true)
  );
}

async function prepareForLocalTranscription(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem("useLocalWhisper", "true");
    localStorage.setItem("whisperModel", "base");
    localStorage.setItem("fileTranscriptionSpeakerDetection", "false");
    localStorage.setItem("whisperForceCpu", "true");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await forceCpuEngine(page);
}

test.describe("Transcribe page language selection", () => {
  test("offers every language through the shared searchable selector", async ({ controlPanel }) => {
    // Local mode, so the evidence screenshots show the page as a local
    // transcription run actually sees it.
    await prepareForLocalTranscription(controlPanel);
    await openTranscribePage(controlPanel);

    fs.mkdirSync(GOAL_EVIDENCE_DIR, { recursive: true });
    await controlPanel.screenshot({
      path: path.join(GOAL_EVIDENCE_DIR, "transcribe-language-selector.png"),
      fullPage: true,
      animations: "disabled",
    });

    await languageTrigger(controlPanel).click();
    await expect(controlPanel.getByRole("option")).toHaveCount(LANGUAGE_OPTION_COUNT);

    // Captured at the top of the list, after the open transition has settled,
    // so the shot shows the search field and the current selection rather than
    // a half-rotated chevron and whatever the list was last scrolled to.
    await expect(controlPanel.getByPlaceholder("Search...")).toBeFocused();
    await controlPanel.screenshot({
      path: path.join(GOAL_EVIDENCE_DIR, "transcribe-language-selector-open.png"),
      fullPage: true,
      animations: "disabled",
    });

    // Reachable only if the list scrolls inside the dropdown rather than being
    // clipped by an ancestor — the failure this page had before.
    const welsh = controlPanel.getByRole("option", { name: "Welsh", exact: true });
    await welsh.scrollIntoViewIfNeeded();
    await expect(welsh).toBeVisible();

    // Search is what makes 58 entries usable at all.
    await controlPanel.getByPlaceholder("Search...").fill("dan");
    await expect(controlPanel.getByRole("option")).toHaveCount(1);
    await expect(controlPanel.getByRole("option", { name: "Danish", exact: true })).toBeVisible();
  });

  test("sends the picked language to whisper-server, for three languages", async ({
    controlPanel,
  }) => {
    // No silent skip: a machine without the model should say so, not report a
    // pass it never earned.
    expect(
      fs.existsSync(BASE_MODEL),
      `ggml-base.bin is not installed at ${BASE_MODEL} — download it before running this spec`
    ).toBe(true);

    await prepareForLocalTranscription(controlPanel);
    await openTranscribePage(controlPanel);

    // "auto" last, so a passing run cannot be explained by the engine simply
    // never having been told anything.
    const samples: { label: string; stored: string; onTheWire: string | null }[] = [
      { label: "Danish", stored: "da", onTheWire: "da" },
      { label: "German", stored: "de", onTheWire: "de" },
      // Auto-detect is the absence of the field: whisper.cpp detects when no
      // language is given, and the app pairs that with detectLanguage so the
      // answer can be pinned for later chunks.
      { label: "Auto-detect", stored: "auto", onTheWire: null },
    ];

    for (const [index, sample] of samples.entries()) {
      if (index > 0) await controlPanel.getByRole("button", { name: "New file" }).click();

      await selectLanguage(controlPanel, sample.label);
      await expect
        .poll(() =>
          controlPanel.evaluate(() => localStorage.getItem("fileTranscriptionLanguage"))
        )
        .toBe(sample.stored);

      const requests = await transcribeControlFile(controlPanel);
      const diagnostics = await readWhisperDiagnostics(controlPanel);
      console.log(
        `[${sample.label}] argv: ${JSON.stringify(diagnostics.lastSpawn?.args)}\n` +
          `[${sample.label}] requests: ${JSON.stringify(requests)}`
      );

      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) {
        expect(request.language).toBe(sample.onTheWire);
        expect(request.detectLanguage).toBe(sample.onTheWire === null);
        expect(request.fileMode).toBe(true);
      }

      // The spawn record is real argv from a real process, not a rebuild of it.
      const args = diagnostics.lastSpawn?.args ?? [];
      expect(Number(diagnostics.lastSpawn?.pid)).toBeGreaterThan(0);
      expect(args).toContain("--model");
      expect(args).toContain("--language");
      // WHISPER_FORCE_CPU must reach the command line, or these timings and
      // this run's isolation from a CUDA engine mean nothing.
      expect(args).toContain("--no-gpu");
    }
  });

  test("keeps the language across a restart, and still sends it", async ({
    controlPanel,
    relaunchElectronApp,
  }) => {
    expect(
      fs.existsSync(BASE_MODEL),
      `ggml-base.bin is not installed at ${BASE_MODEL} — download it before running this spec`
    ).toBe(true);

    await prepareForLocalTranscription(controlPanel);
    await openTranscribePage(controlPanel);
    await selectLanguage(controlPanel, "Danish");

    // A real restart: the process that wrote the choice is gone before the
    // process that reads it back exists.
    const restarted = await relaunchElectronApp();
    await forceCpuEngine(restarted.controlPanel);
    await openTranscribePage(restarted.controlPanel);

    await expect(languageTrigger(restarted.controlPanel)).toHaveText("Danish");

    // Surviving in the UI is half of it; the restarted app must also still hand
    // the code to the engine, from a whisper-server it spawned fresh.
    const requests = await transcribeControlFile(restarted.controlPanel);
    const diagnostics = await readWhisperDiagnostics(restarted.controlPanel);
    console.log(
      `[restart] argv: ${JSON.stringify(diagnostics.lastSpawn?.args)}\n` +
        `[restart] requests: ${JSON.stringify(requests)}`
    );

    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.language).toBe("da");
    }
    expect(diagnostics.lastSpawn?.args ?? []).toContain("--no-gpu");
  });
});
