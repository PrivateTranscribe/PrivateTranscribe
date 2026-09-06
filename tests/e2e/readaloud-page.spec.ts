import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
import { unlockTesterAccess } from "./fixtures/tester-access";
import type { Page } from "@playwright/test";

/**
 * Ledger gate `readaloud-sidebar-page`: Read Aloud is a sidebar page, not a
 * settings tab nobody found. It is beta gated, downloads its voice model
 * through the real model manager, and says out loud that it only speaks
 * English.
 *
 * This replaces readaloud-settings.spec.ts. Every assertion that spec made is
 * still here — locked, no model, downloading, ready, the enable toggle
 * persisting, and real synthesis through the overlay — because moving a
 * feature is only safe if the behaviour is proven at the new address. What is
 * added is the move itself: the sidebar carries the entry, Settings no longer
 * offers the tab.
 *
 * Screenshots land in docs/goal-evidence/ because a design critic reads them
 * afterwards; every state the page can be in gets one, since a state with
 * no picture is a state nobody judged.
 *
 * The download test spends real bandwidth on Hugging Face — a few megabytes,
 * then cancel. That is the point: a mocked download would prove nothing about
 * whether the button is wired to the model manager.
 */

const EVIDENCE_DIR = path.resolve(__dirname, "..", "..", "docs", "goal-evidence");

/** A screenshot that is present but blank would pass a bare existence check. */
const MIN_SCREENSHOT_BYTES = 10_000;

/** Registry total for kokoro-82m-v1.0-fp32, the size the UI promises. */
const EXPECTED_MODEL_BYTES = 326_000_000;

/** Enough sentences that a 3/12 progress position means something. */
const TWELVE_SENTENCES = Array.from(
  { length: 12 },
  (_, i) => `This is sentence number ${i + 1} of the passage being read aloud.`
).join(" ");

async function captureEvidence(page: Page, fileName: string, minBytes = MIN_SCREENSHOT_BYTES) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const filePath = path.join(EVIDENCE_DIR, fileName);
  await page.screenshot({ path: filePath, fullPage: true });

  expect(fs.existsSync(filePath), `${fileName} was not written`).toBe(true);
  const bytes = fs.statSync(filePath).size;
  expect(bytes, `${fileName} is too small to show anything (${bytes} bytes)`).toBeGreaterThan(
    minBytes
  );
  return filePath;
}

/**
 * The sidebar clipped the same way as readaloud-sidebar-before.png, so the
 * pair can be laid side by side. The sidebar is a fixed 220px column; 240
 * catches its right border.
 */
async function captureSidebar(page: Page, fileName: string) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const filePath = path.join(EVIDENCE_DIR, fileName);
  // The pointer stays where the last click left it, so without this the
  // evidence shows a hover state the design never asked for.
  await page.mouse.move(1180, 500);
  const height = await page.evaluate(() => window.innerHeight);
  await page.screenshot({ path: filePath, clip: { x: 0, y: 0, width: 240, height } });

  const bytes = fs.statSync(filePath).size;
  expect(bytes, `${fileName} is too small to show anything (${bytes} bytes)`).toBeGreaterThan(
    5_000
  );
}

/**
 * Unlocked, Read Aloud sits in the sidebar. Locked, it is not listed there and
 * the route runs through the Pro tab's feature card.
 */
async function openReadAloudPage(controlPanel: Page) {
  const entry = controlPanel.getByRole("button", { name: "Read Aloud", exact: true });
  if ((await entry.count()) > 0) {
    await entry.click();
  } else {
    await controlPanel.getByRole("button", { name: "Beta features", exact: true }).click();
    await controlPanel.getByRole("button", { name: /^Read Aloud/ }).click();
  }
  await expect(controlPanel.getByRole("heading", { name: "Read Aloud" })).toBeVisible();
}

test.describe("read aloud page", () => {
  test("stays out of the sidebar while locked, and is no longer a settings tab", async ({
    controlPanel,
  }) => {
    // Locked features are not listed; the one door is the early access row.
    await expect(controlPanel.getByRole("button", { name: /^Read Aloud/ })).toHaveCount(0);
    await expect(
      controlPanel.getByRole("button", { name: "Beta features", exact: true })
    ).toBeVisible();

    // It sits in SPEECH, beside Dictionary, not off in some unrelated group.
    await expect(
      controlPanel.getByRole("button", { name: "Dictionary", exact: true })
    ).toBeVisible();

    await captureSidebar(controlPanel, "readaloud-sidebar-after.png");

    // Settings must not keep a second copy — one home, not two.
    await controlPanel.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(controlPanel.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(controlPanel.getByRole("button", { name: "Read Aloud", exact: true })).toHaveCount(
      0
    );
  });

  test("shows the locked beta state with a way out", async ({ controlPanel }) => {
    await openReadAloudPage(controlPanel);

    await expect(controlPanel.getByText("Beta", { exact: true }).first()).toBeVisible();
    await expect(
      controlPanel.getByRole("button", { name: /Apply for beta access/ })
    ).toBeVisible();
    await expect(controlPanel.getByText("English only.")).toBeVisible();

    // Locked means locked: no download button is reachable from here.
    await expect(controlPanel.getByRole("button", { name: /Download voice model/ })).toHaveCount(0);

    await captureEvidence(controlPanel, "readaloud-page-locked.png");
  });

  test.describe("with tester access and no model on disk", () => {
    test.use({ useThrowawayHome: true });

    test("offers the download and never starts one by itself", async ({ controlPanel }) => {
      await unlockTesterAccess(controlPanel);
      await openReadAloudPage(controlPanel);

      const status = controlPanel.getByTestId("readaloud-model-status");
      await expect(status).toContainText("is not on this machine");
      await expect(controlPanel.getByText("English only.")).toBeVisible();

      const downloadButton = controlPanel.getByRole("button", { name: /Download voice model/ });
      await expect(downloadButton).toBeVisible();
      await expect(downloadButton).toContainText("326 MB");

      // Sitting on the screen must not trigger a 326MB fetch. Nothing here
      // clicks anything for two seconds; the state has to be unchanged after.
      await controlPanel.waitForTimeout(2000);
      await expect(status).toContainText("is not on this machine");
      await expect(controlPanel.getByTestId("readaloud-download-progress")).toHaveCount(0);

      const modelStatus = await controlPanel.evaluate(
        async () => await window.electronAPI.readAloudCheckModelStatus()
      );
      expect(modelStatus.installed, "the app downloaded the model unprompted").toBe(false);

      await captureEvidence(controlPanel, "readaloud-page-no-model.png");
    });

    test("downloads through the model manager and cancels cleanly", async ({ controlPanel }) => {
      // A real HTTP download plus its cancellation; the default 30s is tight.
      test.setTimeout(120_000);

      await unlockTesterAccess(controlPanel);
      await openReadAloudPage(controlPanel);

      const modelDir = (
        await controlPanel.evaluate(
          async () => await window.electronAPI.readAloudCheckModelStatus()
        )
      ).dir;
      // The model manager streams into `<file>.tmp` and only renames on
      // completion, so this path is what proves the bytes went through it.
      const tmpPath = path.join(modelDir, "onnx", "model.onnx.tmp");

      await controlPanel.getByRole("button", { name: /Download voice model/ }).click();

      const progress = controlPanel.getByTestId("readaloud-download-progress");
      await expect(progress).toBeVisible({ timeout: 30_000 });

      // Wait for a percentage the user could actually read, which is also the
      // first proof that bytes are arriving rather than a bar being rendered.
      await expect(progress).toContainText(/[1-9]\d*%/, { timeout: 15_000 });

      await captureEvidence(controlPanel, "readaloud-page-downloading.png");

      await controlPanel.getByRole("button", { name: /Cancel download/ }).click();

      const status = controlPanel.getByTestId("readaloud-model-status");
      await expect(status).toContainText("is not on this machine", { timeout: 20_000 });
      await expect(
        controlPanel.getByRole("button", { name: /Download voice model/ })
      ).toBeVisible();

      const modelStatus = await controlPanel.evaluate(
        async () => await window.electronAPI.readAloudCheckModelStatus()
      );
      expect(modelStatus.installed, "a cancelled download must not read as installed").toBe(false);

      // The abort has to reach the socket, not just the UI: a partial file that
      // keeps growing after cancel means the transfer is still running.
      const sizeAt = () => (fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0);
      const firstSample = sizeAt();
      await controlPanel.waitForTimeout(2000);
      expect(sizeAt(), "the partial download kept growing after cancel").toBe(firstSample);
    });
  });

  test.describe("with the model installed", () => {
    test.use({ seedKokoroModel: true });

    test("shows the size on disk and lets the feature be turned on", async ({ controlPanel }) => {
      await unlockTesterAccess(controlPanel);
      await openReadAloudPage(controlPanel);

      const modelStatus = await controlPanel.evaluate(
        async () => await window.electronAPI.readAloudCheckModelStatus()
      );
      expect(modelStatus.installed).toBe(true);
      // Within 5% of the 326MB the download button promises, so the number in
      // the UI cannot drift away from what is actually on disk.
      expect(Math.abs(modelStatus.totalBytes - EXPECTED_MODEL_BYTES)).toBeLessThan(
        EXPECTED_MODEL_BYTES * 0.05
      );

      const status = controlPanel.getByTestId("readaloud-model-status");
      await expect(status).toContainText("on this machine");
      await expect(status).toContainText("MB");
      await expect(controlPanel.getByText("English only.")).toBeVisible();

      // The enable toggle is the last control on the page; it is the one
      // that binds the global shortcut, so it must be reachable now.
      const toggleRow = controlPanel
        .getByText("Read the selected text out loud", { exact: true })
        .locator("xpath=ancestor::div[contains(@class,'justify-between')][1]");
      const toggle = toggleRow.locator("button");
      await expect(toggle).toBeEnabled();
      await toggle.click();

      expect(await controlPanel.evaluate(() => localStorage.getItem("readAloudEnabled"))).toBe(
        "true"
      );
      // The screenshot is the evidence, so the toggle has to *look* on in it.
      await expect(toggle).toHaveClass(/bg-primary/);
      // The class lands instantly; the knob slides over 150ms of CSS
      // transition, which is not a Web Animation and so cannot be waited on.
      // The previous evidence was shot mid-slide and showed an "on" toggle
      // with its knob still on the left.
      await controlPanel.waitForTimeout(500);
      await expect(toggle.locator("span")).toHaveClass(/translate-x-3\.5/);

      await captureEvidence(controlPanel, "readaloud-page-ready.png");
    });

    test("shows a player on the overlay while it reads", async ({ overlayWindow }) => {
      // Cold model load plus real synthesis.
      test.setTimeout(120_000);

      await overlayWindow.waitForFunction(() => Boolean((window as any).__readAloudTest), null, {
        timeout: 30_000,
      });

      await overlayWindow.evaluate((text) => {
        (window as any).__readAloudTest.speak(text);
      }, TWELVE_SENTENCES);

      const player = overlayWindow.getByTestId("readaloud-overlay-player");
      await expect(player).toBeVisible({ timeout: 30_000 });
      await expect(player).toContainText("Reading aloud", { timeout: 60_000 });
      // Sentence position, so the listener knows how much is left.
      await expect(player.getByTestId("readaloud-progress")).toHaveAttribute(
        "data-position",
        /^\d+\/12$/
      );
      await expect(overlayWindow.getByRole("button", { name: "Pause reading" })).toBeVisible();
      await expect(overlayWindow.getByRole("button", { name: "Stop reading" })).toBeVisible();

      await captureEvidence(overlayWindow, "readaloud-overlay-player.png", 3_000);

      await overlayWindow.getByRole("button", { name: "Pause reading" }).click();
      await expect(player).toContainText("Paused");
      await expect(overlayWindow.getByRole("button", { name: "Resume reading" })).toBeVisible();

      await captureEvidence(overlayWindow, "readaloud-overlay-player-paused.png", 3_000);

      await overlayWindow.getByRole("button", { name: "Stop reading" }).click();
      await expect(player).toHaveCount(0);
    });
  });
});
