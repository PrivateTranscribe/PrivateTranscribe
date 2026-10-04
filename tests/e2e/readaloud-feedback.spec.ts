import fs from "node:fs";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";
import { evidenceDir } from "./fixtures/evidence";

/**
 * Ledger gate `readaloud-empty-selection-feedback`: pressing the read hotkey
 * always answers, and a read that fell back to the clipboard says so.
 *
 * Two failures are being covered, both of which were silent:
 *
 *   1. A capture with nothing to read sent the overlay nothing at all, so an
 *      empty selection and a shortcut that never fired looked identical.
 *   2. When the injected Ctrl+C produced nothing but an old clipboard value
 *      existed, that value was read aloud as if it were the selection.
 *
 * The events are delivered straight to the overlay's webContents rather than by
 * driving the desktop. That is deliberate: readaloud-selection.spec.ts already
 * proves the capture path produces those events with a real Notepad selection,
 * and repeating the Notepad automation here would make a UI-feedback spec
 * depend on an unlocked, uncontested desktop. What is unproven by that spec is
 * what the overlay *does* with each event, which is exactly what this asserts —
 * through the real preload bridge and the real App.jsx listeners.
 */

const EVIDENCE_DIR = evidenceDir("readaloud-feedback");

/** The overlay is a small window; its screenshots are much smaller than a page. */
const MIN_SCREENSHOT_BYTES = 3_000;

/** Two sentences: enough that a 1/2 progress position is real. */
const TWO_SENTENCES =
  "This text was not selected in any application. It came straight from the clipboard.";

async function captureEvidence(page: Page, fileName: string) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const filePath = path.join(EVIDENCE_DIR, fileName);
  await page.screenshot({ path: filePath, fullPage: true });

  const bytes = fs.statSync(filePath).size;
  expect(bytes, `${fileName} is too small to show anything (${bytes} bytes)`).toBeGreaterThan(
    MIN_SCREENSHOT_BYTES
  );
}

/**
 * Push one of the main process's Read Aloud events at the overlay.
 *
 * Sent from the main process over the same channel readSelectionAndSpeak uses,
 * so the payload crosses the real contextBridge and lands in the real listener.
 */
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

test.describe("read aloud feedback", () => {
  test.describe("with nothing to read", () => {
    test("shows a transient pill instead of doing nothing at all", async ({
      electronApp,
      overlayWindow,
    }) => {
      const notice = overlayWindow.getByTestId("readaloud-overlay-notice");

      // Nothing on screen before the press: the pill has to be caused by it.
      await expect(notice).toHaveCount(0);

      await sendToOverlay(electronApp, "readaloud-notice", { reason: "empty-selection" });

      await expect(notice).toBeVisible();
      await expect(notice).toHaveText("Nothing selected to read aloud");
      // No model is loaded in this test, so nothing can have been spoken —
      // the pill is the entire answer to the press.
      await expect(overlayWindow.getByTestId("readaloud-overlay-player")).toHaveCount(0);

      await captureEvidence(overlayWindow, "readaloud-pill-nothing-selected.png");

      // It must clear itself. A hint that needs dismissing would sit in front of
      // the dictation button until the user noticed it.
      await expect(notice).toHaveCount(0, { timeout: 8_000 });
    });

    test("says something different when captures are not possible at all", async ({
      electronApp,
      overlayWindow,
    }) => {
      // "Nothing selected" would send a user whose platform cannot capture at
      // all off looking for a selection to make.
      await sendToOverlay(electronApp, "readaloud-notice", { reason: "unsupported" });

      const notice = overlayWindow.getByTestId("readaloud-overlay-notice");
      await expect(notice).toBeVisible();
      await expect(notice).toHaveText("Cannot read selections here");
    });

    test("ignores a notice it has no wording for", async ({ electronApp, overlayWindow }) => {
      await sendToOverlay(electronApp, "readaloud-notice", { reason: "something-new" });

      // An empty pill would be worse than no pill.
      await overlayWindow.waitForTimeout(500);
      await expect(overlayWindow.getByTestId("readaloud-overlay-notice")).toHaveCount(0);
    });
  });

  test.describe("while reading", () => {
    test.use({ seedKokoroModel: true });

    // Real synthesis after a cold 326MB model load.
    test.setTimeout(180_000);

    /** Load the engine up front so the label assertions are not waiting on it. */
    async function loadEngine(overlayWindow: Page) {
      const status = await overlayWindow.evaluate(
        async () => await (window as any).electronAPI.readAloudLoadEngine()
      );
      expect(status.loaded, `engine failed to load: ${status.error}`).toBe(true);
    }

    test("labels a clipboard fallback as the clipboard, not the selection", async ({
      electronApp,
      overlayWindow,
    }) => {
      await loadEngine(overlayWindow);

      await sendToOverlay(electronApp, "readaloud-speak", {
        text: TWO_SENTENCES,
        source: "clipboard",
      });

      const player = overlayWindow.getByTestId("readaloud-overlay-player");
      await expect(player).toBeVisible({ timeout: 30_000 });
      await expect(player).toContainText("Reading clipboard", { timeout: 60_000 });
      // The text is still being read, and the position readout still works —
      // labelling it must not turn it into a warning that does nothing.
      await expect(player.getByTestId("readaloud-progress")).toHaveAttribute(
        "data-position",
        /^\d+\/2$/
      );
      await expect(overlayWindow.getByRole("button", { name: "Pause reading" })).toBeVisible();
      await expect(player).not.toContainText("Reading aloud");

      await captureEvidence(overlayWindow, "readaloud-pill-clipboard.png");

      await overlayWindow.getByRole("button", { name: "Stop reading" }).click();
      await expect(player).toHaveCount(0);
    });

    test("still says Reading aloud for a real selection, and clears a notice", async ({
      electronApp,
      overlayWindow,
    }) => {
      await loadEngine(overlayWindow);

      // A press that found nothing, immediately followed by one that did: the
      // stale hint must not outlive the read that replaced it.
      await sendToOverlay(electronApp, "readaloud-notice", { reason: "empty-selection" });
      await expect(overlayWindow.getByTestId("readaloud-overlay-notice")).toBeVisible();

      await sendToOverlay(electronApp, "readaloud-speak", {
        text: TWO_SENTENCES,
        source: "selection",
      });

      const player = overlayWindow.getByTestId("readaloud-overlay-player");
      await expect(player).toBeVisible({ timeout: 30_000 });
      await expect(overlayWindow.getByTestId("readaloud-overlay-notice")).toHaveCount(0);

      await expect(player).toContainText("Reading aloud", { timeout: 60_000 });
      await expect(player).not.toContainText("Reading clipboard");

      await overlayWindow.getByRole("button", { name: "Stop reading" }).click();
      await expect(player).toHaveCount(0);
    });
  });
});
