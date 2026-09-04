import fs from "node:fs";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";

/**
 * Ledger gate `readaloud-nonenglish-guard`: Kristian pressed the Read Aloud
 * hotkey on Danish text and got English-phoneme garbage, because the
 * bundled phonemizer only knows English. `checkReadAloudLanguage`
 * (src/helpers/readAloudLanguageGuard.js) now runs before synthesis and
 * blocks confidently non-English captures instead of speaking them.
 *
 * Two things are proven here, both through the real main process:
 *
 *   1. `readAloudLanguageCheck` - a thin IPC wrapper that exists only so this
 *      spec can call the real guard (real dynamic `tinyld` import included)
 *      without driving desktop selection capture. tests/unit covers the
 *      guard's decision logic in isolation; this covers that the IPC wiring
 *      to it is real, in the real Electron main process.
 *   2. The overlay's "non-english" notice pill, driven the same way
 *      readaloud-feedback.spec.ts drives its notices: the event is sent
 *      straight to the overlay's webContents rather than by triggering an
 *      actual blocked read, because readSelectionAndSpeak() itself is
 *      exercised by readaloud-selection.spec.ts's real desktop capture, and
 *      what's unproven by that is only what the overlay does with the event.
 */

const EVIDENCE_DIR = path.resolve(__dirname, "..", "..", "docs", "goal-evidence");
const MIN_SCREENSHOT_BYTES = 1_000;

const DANISH_PARAGRAPH =
  "Det er en dejlig dag i dag, og solen skinner smukt over hele byen. Jeg har lyst til at gå en tur i parken senere.";
const ENGLISH_PARAGRAPH =
  "It is a lovely day today, and the sun is shining beautifully over the whole city. I want to take a walk in the park later.";

async function captureEvidence(page: Page, fileName: string) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const filePath = path.join(EVIDENCE_DIR, fileName);
  await page.screenshot({ path: filePath, fullPage: true });

  const bytes = fs.statSync(filePath).size;
  expect(bytes, `${fileName} is too small to show anything (${bytes} bytes)`).toBeGreaterThan(
    MIN_SCREENSHOT_BYTES
  );
}

/** Push one of the main process's Read Aloud events straight at the overlay. */
async function sendToOverlay(
  electronApp: ElectronApplication,
  channel: string,
  payload: unknown
): Promise<void> {
  const delivered = await electronApp.evaluate(
    ({ BrowserWindow }, args) => {
      const overlay = BrowserWindow.getAllWindows().find((win) => {
        if (win.isDestroyed()) return false;
        const url = win.webContents.getURL();
        return url.includes("index.html") && !url.includes("panel=true");
      });
      if (!overlay) return false;
      overlay.webContents.send(args.channel, args.payload);
      return true;
    },
    { channel, payload }
  );

  expect(delivered, `no overlay window was available to receive ${channel}`).toBe(true);
}

test.describe("read aloud non-english guard", () => {
  test("readAloudLanguageCheck blocks Danish and clears English, through the real guard", async ({
    overlayWindow,
  }) => {
    const danish = await overlayWindow.evaluate(
      async (text) => await (window as any).electronAPI.readAloudLanguageCheck(text),
      DANISH_PARAGRAPH
    );
    expect(danish.block).toBe(true);
    expect(danish.languageName).toBe("Danish");

    const english = await overlayWindow.evaluate(
      async (text) => await (window as any).electronAPI.readAloudLanguageCheck(text),
      ENGLISH_PARAGRAPH
    );
    expect(english.block).toBe(false);
  });

  test("shows the detected language in the overlay pill and clears itself", async ({
    electronApp,
    overlayWindow,
  }) => {
    const notice = overlayWindow.getByTestId("readaloud-overlay-notice");
    await expect(notice).toHaveCount(0);

    await sendToOverlay(electronApp, "readaloud-notice", {
      reason: "non-english",
      languageName: "Danish",
    });

    await expect(notice).toBeVisible();
    await expect(notice).toHaveText("Looks like Danish, Read Aloud speaks English only");
    // Captured once its 180ms entrance has landed and before its 2.5s life
    // ends: taken any earlier the evidence is a half-faded ghost (it was,
    // twice), any later it is an empty window.
    await notice.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    await captureEvidence(overlayWindow, "readaloud-nonenglish-notice.png");
    // Nothing is or was being spoken - the guard runs before synthesis.
    await expect(overlayWindow.getByTestId("readaloud-overlay-player")).toHaveCount(0);

    await expect(notice).toHaveCount(0, { timeout: 8_000 });
  });

  test("falls back to generic wording when no language name is carried", async ({
    electronApp,
    overlayWindow,
  }) => {
    await sendToOverlay(electronApp, "readaloud-notice", { reason: "non-english" });

    const notice = overlayWindow.getByTestId("readaloud-overlay-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveText("Read Aloud speaks English only");
  });
});
