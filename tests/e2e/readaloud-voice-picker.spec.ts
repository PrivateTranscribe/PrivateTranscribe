import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
import { unlockTesterAccess } from "./fixtures/tester-access";
import {
  DEFAULT_KOKORO_VOICE_ID,
  SORTED_KOKORO_VOICES,
  VOICE_STORAGE_KEY,
  findVoice,
} from "../../src/models/kokoroVoices";
import type { Locator, Page } from "@playwright/test";

/**
 * Ledger gate `readaloud-voice-picker`.
 *
 * Read Aloud shipped with one hardcoded voice. This proves the picker offers
 * every voice the engine can actually speak, that the play button produces real
 * audio for the voice it names, that a choice survives a reload, and — the part
 * that would otherwise silently not work — that the overlay's player, which
 * lives in a different window from the picker, speaks with the chosen voice.
 *
 * The model is the real one, hardlinked in by the fixture. Nothing here is
 * mocked, and there is no `test.skip` for a missing model: the fixture throws
 * instead, because a skipped run would hide exactly what is being measured.
 */

test.use({ seedKokoroModel: true });

/** Above the noise floor of a decoded buffer; matches readaloud-engine.spec.ts. */
const SILENCE_RMS_FLOOR = 0.01;

const EVIDENCE_DIR = path.resolve(__dirname, "..", "..", "docs", "goal-evidence");

type PreviewReport = {
  voice: string;
  rms: number;
  seconds: number;
  status: "synthesizing" | "playing" | "done" | "error";
} | null;

/** Reach the unlocked Read Aloud page with the model installed. */
async function openReadAloud(controlPanel: Page): Promise<Locator> {
  await unlockTesterAccess(controlPanel);
  await controlPanel.getByRole("button", { name: /^Read Aloud( Beta)?$/ }).click();
  await expect(controlPanel.getByRole("heading", { name: "Read Aloud" })).toBeVisible();

  // The picker only renders once the model status read comes back installed.
  const picker = controlPanel.getByTestId("readaloud-voice-picker");
  await expect(picker).toBeVisible({ timeout: 60_000 });
  return picker;
}

/** The app's one voice key. Converse reads the same value. */
const storedVoice = (page: Page) =>
  page.evaluate((key) => localStorage.getItem(key), VOICE_STORAGE_KEY);

/**
 * Shoot the section rather than the page: the rows, accent headings and preview
 * buttons are what a critic has to judge, and a full-page capture renders them
 * too small to read.
 */
async function captureSection(section: Locator, fileName: string) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const filePath = path.join(EVIDENCE_DIR, fileName);
  await section.screenshot({ path: filePath });

  const bytes = fs.statSync(filePath).size;
  expect(bytes, `${fileName} is too small to show anything (${bytes} bytes)`).toBeGreaterThan(
    1_000
  );
}

/** Press a voice's real play button and wait for the decoded-buffer report. */
async function previewVoice(controlPanel: Page, voiceId: string): Promise<PreviewReport> {
  await controlPanel.getByTestId(`readaloud-voice-preview-${voiceId}`).click();

  return controlPanel.evaluate(async (id) => {
    const surface = (window as any).__voicePickerTest;
    const deadline = Date.now() + 60_000;
    for (;;) {
      const report = surface?.getLastPreview?.();
      if (
        report?.voice === id &&
        (report.status === "playing" || report.status === "done" || report.status === "error")
      ) {
        return report;
      }
      if (Date.now() > deadline) return report ?? null;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }, voiceId);
}

test.describe("read aloud voice picker", () => {
  // Real activation, a cold model status read, and real CPU synthesis.
  test.setTimeout(180_000);

  test("lists every speakable voice in the designed order", async ({ controlPanel }) => {
    const picker = await openReadAloud(controlPanel);

    const rendered = await picker.locator("[data-voice-id]").evaluateAll((rows) =>
      rows.map((row) => ({
        id: row.getAttribute("data-voice-id"),
        name: (row.querySelector("span") as HTMLElement | null)?.textContent ?? "",
      }))
    );

    expect(rendered).toHaveLength(28);
    // The rendered order IS the module's order, compared against the export
    // rather than a copied-out list, so the two cannot drift. Since 2026-08-24
    // that order is kokoro-js's original table order — Kristian rejected
    // grade-sorting as subjective.
    expect(rendered.map((row) => row.id)).toEqual(SORTED_KOKORO_VOICES.map((v) => v.id));

    const firstRow = picker.locator("[data-voice-id]").first();
    await expect(firstRow).toHaveAttribute("data-voice-id", SORTED_KOKORO_VOICES[0].id);
    await expect(firstRow).toContainText(SORTED_KOKORO_VOICES[0].name);

    // One heading per accent, and no letter grade anywhere: the grades were
    // removed on 2026-08-30, so a row must carry only what a person can check
    // for themselves — the name, the gender, and the play button.
    await expect(picker.getByText("American", { exact: true })).toBeVisible();
    await expect(picker.getByText("British", { exact: true })).toBeVisible();
    const rowText = await picker.locator("[data-voice-id]").allInnerTexts();
    expect(rowText.join(" ")).not.toMatch(/[A-DF][+-]?/);

    // Default state: the default voice selected, header naming it.
    const fallback = findVoice(DEFAULT_KOKORO_VOICE_ID)!;
    await expect(controlPanel.getByTestId("readaloud-voice-current")).toHaveText(fallback.name);
    await expect(picker.locator(`[data-voice-id="${fallback.id}"]`)).toHaveAttribute(
      "data-selected",
      "true"
    );

    await captureSection(picker, "readaloud-voice-picker.png");
  });

  test("the play button produces audible audio for the voice it names", async ({
    controlPanel,
  }) => {
    const picker = await openReadAloud(controlPanel);

    // Two different voices, neither of them the default, so a hardcoded voice
    // on the synth path could not pass this.
    for (const voiceId of ["bf_emma", "am_puck"]) {
      const report = await previewVoice(controlPanel, voiceId);

      expect(report, `no preview report for ${voiceId}`).not.toBeNull();
      expect(report!.status, `${voiceId} preview failed`).not.toBe("error");
      expect(report!.voice, `${voiceId} preview reported the wrong voice`).toBe(voiceId);
      expect(report!.seconds, `${voiceId} preview duration`).toBeGreaterThan(0.5);
      expect(report!.rms, `${voiceId} preview RMS (silence check)`).toBeGreaterThan(
        SILENCE_RMS_FLOOR
      );

      console.log(
        `PREVIEW voice=${voiceId} rms=${report!.rms.toFixed(4)} seconds=${report!.seconds.toFixed(2)}`
      );
    }

    // Previewing never changes the selection - the two are separate actions.
    expect(await storedVoice(controlPanel)).toBe(DEFAULT_KOKORO_VOICE_ID);
    await expect(controlPanel.getByTestId("readaloud-voice-current")).toHaveText(
      findVoice(DEFAULT_KOKORO_VOICE_ID)!.name
    );

    // Captured after both previews completed rather than mid-synthesis: the
    // busy state lasts a few hundred milliseconds and racing a screenshot
    // against it would be flaky. The list state it shows is real either way.
    await captureSection(picker, "readaloud-voice-picker-preview.png");
  });

  test("a chosen voice is stored and survives a reload", async ({ controlPanel }) => {
    let picker = await openReadAloud(controlPanel);

    await picker.locator('[data-voice-id="bm_fable"] [role="radio"]').click();

    await expect.poll(() => storedVoice(controlPanel)).toBe("bm_fable");
    await expect(controlPanel.getByTestId("readaloud-voice-current")).toHaveText("Fable");
    await expect(picker.locator('[data-voice-id="bm_fable"]')).toHaveAttribute(
      "data-selected",
      "true"
    );
    await expect(picker.locator(`[data-voice-id="${DEFAULT_KOKORO_VOICE_ID}"]`)).toHaveAttribute(
      "data-selected",
      "false"
    );

    // A reload rebuilds the page from storage, which is the only thing the
    // overlay will read later.
    await controlPanel.reload({ waitUntil: "domcontentloaded" });
    await controlPanel.getByRole("button", { name: /^Read Aloud( Beta)?$/ }).click();
    picker = controlPanel.getByTestId("readaloud-voice-picker");
    await expect(picker).toBeVisible({ timeout: 60_000 });

    expect(await storedVoice(controlPanel)).toBe("bm_fable");
    await expect(controlPanel.getByTestId("readaloud-voice-current")).toHaveText("Fable");
    await expect(picker.locator('[data-voice-id="bm_fable"]')).toHaveAttribute(
      "data-selected",
      "true"
    );

    // Fable is the last of 28 rows, far below the ~6 the list shows. Arriving
    // on the page has to put it on screen, or the only way to see what is
    // selected is to scroll and hunt for the check mark.
    // Measured with rects, not offsetTop: offsetTop is relative to the nearest
    // positioned ancestor rather than the scroll container, and an assertion
    // using it agrees with a scroll that used it - including when both are
    // wrong. Geometry on screen is the thing being claimed, so measure that.
    const visible = await picker
      .locator('[data-voice-id="bm_fable"]')
      .evaluate((row: HTMLElement) => {
        const list = row.parentElement as HTMLElement;
        const rowRect = row.getBoundingClientRect();
        const listRect = list.getBoundingClientRect();
        return rowRect.top >= listRect.top - 1 && rowRect.bottom <= listRect.bottom + 1;
      });
    expect(visible, "the selected row is not on screen when the page opens").toBe(true);

    // Shot after the reload rather than after the click, so the evidence is the
    // state a user actually arrives in.
    await captureSection(picker, "readaloud-voice-picker-selected.png");
  });

  test("the overlay speaks with the voice the picker chose", async ({
    controlPanel,
    overlayWindow,
  }) => {
    const picker = await openReadAloud(controlPanel);
    await picker.locator('[data-voice-id="bf_emma"] [role="radio"]').click();
    await expect.poll(() => storedVoice(controlPanel)).toBe("bf_emma");

    await overlayWindow.waitForFunction(() => Boolean((window as any).__readAloudTest), null, {
      timeout: 30_000,
    });

    // localStorage propagates between renderers asynchronously. Waiting for the
    // overlay's own view of the key keeps the assertion about the player, not
    // about Chromium's replication timing.
    await expect
      .poll(() => overlayWindow.evaluate((key) => localStorage.getItem(key), VOICE_STORAGE_KEY), {
        timeout: 15_000,
      })
      .toBe("bf_emma");

    await overlayWindow.evaluate(() => {
      // Not awaited: speak() resolves only once playback has started.
      (window as any).__readAloudTest.speak("Testing voice selection.");
    });

    const state = await overlayWindow.evaluate(async () => {
      const surface = (window as any).__readAloudTest;
      const deadline = Date.now() + 60_000;
      for (;;) {
        const current = surface.getState();
        if (current.ttfaMs !== null || current.status === "error" || Date.now() > deadline) {
          return current;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    });

    expect(state.error, "overlay read errored").toBeNull();
    expect(state.ttfaMs, "overlay never reached first audio").not.toBeNull();
    expect(state.voice, "overlay spoke with the wrong voice").toBe("bf_emma");

    await overlayWindow.evaluate(() => (window as any).__readAloudTest.stop());
  });
});
