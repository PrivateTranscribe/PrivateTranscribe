import fs from "node:fs";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";

/**
 * Ledger gate `overlay-unification`: the overlay is one control, not three.
 *
 * The dictation button, the Read Aloud player and the Converse status used to
 * be three surfaces with three widths, three corner radii and three gaps,
 * floating over the same transparent window. This spec pins the geometry that
 * replaced them, so it cannot quietly come apart again:
 *
 *   1. Idle, the overlay is the button and nothing else.
 *   2. Every surface the overlay shows is a row in one column, and every row
 *      is a STATUS capsule: it hugs its words and never exceeds the column.
 *      (A PANEL shape - full column width - is kept in the helper for any
 *      row that ever needs one; today none does.)
 *   3. The bottom row floats a fixed, small gap above the button's cap - never
 *      touching it, never overlapping it - and every row is centred on the
 *      button, so the pair reads as one control and its caption.
 *
 * It is also where the gate's evidence screenshots come from, which is why
 * each state is captured as well as asserted.
 */

const EVIDENCE_DIR = path.resolve(__dirname, "..", "..", "docs", "goal-evidence");
const MIN_SCREENSHOT_BYTES = 1_000;

/** Mirrors the constants in src/App.jsx. A change here is a change of design. */
const COLUMN_W = 352;
const BUTTON_GAP = 8;

const FIVE_SENTENCES = [
  "The first sentence mentions a paddleboat.",
  "The second sentence mentions a lighthouse.",
  "The third sentence mentions a windmill.",
  "The fourth sentence mentions a compass.",
  "The fifth sentence mentions a harbour.",
].join(" ");

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

/**
 * The whole gate in one assertion: this row belongs to the column, and the
 * column is attached to the button.
 */
async function expectDockedToButton(
  overlayWindow: Page,
  row: ReturnType<Page["getByTestId"]>,
  { shape }: { shape: "panel" | "status" }
) {
  // Every row grows out of the anchor on its way in. Measuring mid-entrance
  // measures the scale the row is passing through, not the one it lands on.
  await row.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });

  const rowBox = await row.boundingBox();
  const buttonBox = await overlayWindow
    .getByRole("button", { name: "Dictation overlay" })
    .boundingBox();

  expect(rowBox, "the row has no box to measure").not.toBeNull();
  expect(buttonBox, "the dictation button has no box to measure").not.toBeNull();
  if (!rowBox || !buttonBox) return;

  if (shape === "panel") {
    // One column width, in every state, so the slot never resizes under the user.
    expect(Math.round(rowBox.width), "panel width is the column width").toBe(COLUMN_W);
  } else {
    // A status row is its words on a capsule: narrower than the column, never
    // wider. Stretched to the column it left a dead rail either side of two
    // words, the nit both critics recorded when the column first landed.
    expect(Math.round(rowBox.width), "status row stays inside the column").toBeLessThanOrEqual(
      COLUMN_W
    );
    expect(rowBox.width, "status row hugs its words").toBeLessThan(COLUMN_W);
  }

  // Centred on the button: the button is the anchor the column grows from.
  const rowCentre = rowBox.x + rowBox.width / 2;
  const buttonCentre = buttonBox.x + buttonBox.width / 2;
  expect(Math.abs(rowCentre - buttonCentre), "column is centred on the button").toBeLessThan(1.5);

  // A constant hair of air above the cap: the borders never cross, and the
  // gap is the same for a capsule and a panel.
  const gap = buttonBox.y - (rowBox.y + rowBox.height);
  expect(Math.round(gap), "row floats the fixed gap above the button's cap").toBe(BUTTON_GAP);
}

test.describe("overlay unification", () => {
  test("idle, the overlay is the dictation button and nothing else", async ({ overlayWindow }) => {
    await expect(overlayWindow.getByRole("button", { name: "Dictation overlay" })).toBeVisible();
    await expect(overlayWindow.getByTestId("readaloud-overlay-player")).toHaveCount(0);
    await expect(overlayWindow.getByTestId("readaloud-overlay-notice")).toHaveCount(0);
    await expect(overlayWindow.getByTestId("converse-overlay-state")).toHaveCount(0);

    await captureEvidence(overlayWindow, "overlay-unified-idle.png");
  });

  test("a notice docks to the button as a row of the column", async ({
    electronApp,
    overlayWindow,
  }) => {
    await sendToOverlay(electronApp, "readaloud-notice", { reason: "empty-selection" });

    const notice = overlayWindow.getByTestId("readaloud-overlay-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveText("Nothing selected to read aloud");
    await expectDockedToButton(overlayWindow, notice, { shape: "status" });

    await captureEvidence(overlayWindow, "overlay-unified-notice-empty.png");
  });

  test("the longest notice still fits the column", async ({ electronApp, overlayWindow }) => {
    // The non-English wording carries a language name, so it is the widest
    // thing the overlay ever has to say. It has to wrap inside the column
    // rather than run past its edge.
    await sendToOverlay(electronApp, "readaloud-notice", {
      reason: "non-english",
      languageName: "Danish",
    });

    const notice = overlayWindow.getByTestId("readaloud-overlay-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveText("Looks like Danish, Read Aloud speaks English only");
    await expectDockedToButton(overlayWindow, notice, { shape: "status" });

    await captureEvidence(overlayWindow, "overlay-unified-notice-nonenglish.png");
  });

  test.describe("while a read is running", () => {
    test.use({ seedKokoroModel: true });
    test.setTimeout(180_000);

    test("the player is the same docked row, playing and paused", async ({ overlayWindow }) => {
      await overlayWindow.waitForFunction(() => Boolean((window as any).__readAloudTest), null, {
        timeout: 30_000,
      });

      const engineStatus = await overlayWindow.evaluate(
        async () => await (window as any).electronAPI.readAloudLoadEngine()
      );
      expect(engineStatus.loaded, `engine failed to load: ${engineStatus.error}`).toBe(true);

      await overlayWindow.evaluate((text) => {
        (window as any).__readAloudTest.speak(text);
      }, FIVE_SENTENCES);

      const player = overlayWindow.getByTestId("readaloud-overlay-player");
      const sentenceLine = overlayWindow.getByTestId("readaloud-current-sentence");
      await expect(player).toBeVisible({ timeout: 60_000 });
      await expect(sentenceLine).toHaveCount(0);

      // The player and the notice hug their words the same way and float the
      // same way — that is what makes them one family rather than two.
      await expectDockedToButton(overlayWindow, player, { shape: "status" });
      await captureEvidence(overlayWindow, "overlay-unified-reading.png");

      await overlayWindow.getByRole("button", { name: "Pause reading" }).click();
      // Off the controls before the shot: a hovered or still-focused button
      // would put a state in the evidence that the paused overlay is not in.
      await overlayWindow.mouse.move(4, 4);
      await overlayWindow.evaluate(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
      });
      await expect(player).toContainText("Paused");
      await expectDockedToButton(overlayWindow, player, { shape: "status" });
      await captureEvidence(overlayWindow, "overlay-unified-paused.png");

      await overlayWindow.evaluate(() => (window as any).__readAloudTest.stop());
      await expect(player).toHaveCount(0, { timeout: 10_000 });
    });
  });
});
