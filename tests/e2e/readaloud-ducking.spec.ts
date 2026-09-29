import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";
import { unlockTesterAccess } from "./fixtures/tester-access";

/**
 * Ledger gate `readaloud-ducking`: while a read is on screen, every OTHER app
 * gets quieter and PrivateTranscribe's own voice does not.
 *
 * What this spec can and cannot prove, stated plainly:
 *
 *   - It proves the WIRING. `readaloud-playback-active` is the one edge the
 *     overlay reports, and the ducking module has to be asked to duck on the
 *     way in and to restore on the way out, with the page's toggle riding along
 *     on the same call.
 *   - It does NOT prove the volumes move, and must not: a test run would be
 *     changing the volume of whatever the developer is listening to. The
 *     fixture sets PRIVATETRANSCRIBE_DIAG_DISABLE_AUDIO_DUCKING, so the module
 *     records the request and stops before PowerShell. That the real Core Audio
 *     calls work is proven by a live check against silent helper apps, recorded
 *     in the ledger with its before/duck/restore numbers.
 *
 * `lastReason === "diagnostic-flag"` is therefore load-bearing twice over: it
 * shows the module was reached, AND that it went no further.
 */

const EVIDENCE_DIR = path.resolve(__dirname, "..", "..", "docs", "goal-evidence");
const MIN_SCREENSHOT_BYTES = 10_000;

type DuckingStatus = {
  supported: boolean;
  ducked: boolean;
  sessions: number;
  duckRequests: number;
  restoreRequests: number;
  duckCalls: number;
  restoreCalls: number;
  repairs: number;
  lastReason: string | null;
};

async function captureEvidence(page: Page, fileName: string) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const filePath = path.join(EVIDENCE_DIR, fileName);
  await page.screenshot({ path: filePath, fullPage: true });

  expect(fs.existsSync(filePath), `${fileName} was not written`).toBe(true);
  const bytes = fs.statSync(filePath).size;
  expect(bytes, `${fileName} is too small to show anything (${bytes} bytes)`).toBeGreaterThan(
    MIN_SCREENSHOT_BYTES
  );
}

/** Report a playback edge exactly as the overlay does, and read the reply. */
async function reportPlayback(
  overlayWindow: Page,
  active: boolean,
  options?: { duckOthers?: boolean }
): Promise<DuckingStatus> {
  const reply = await overlayWindow.evaluate(
    async ({ isActive, opts }) =>
      await (window as any).electronAPI.readAloudSetPlaybackActive(isActive, opts ?? {}),
    { isActive: active, opts: options }
  );
  expect(reply.ducking, "the playback-active reply carried no ducking status").toBeTruthy();
  return reply.ducking as DuckingStatus;
}

async function openReadAloudPage(controlPanel: Page) {
  await controlPanel.getByRole("button", { name: /^Read Aloud( Beta)?$/ }).click();
  await expect(controlPanel.getByRole("heading", { name: "Read Aloud" })).toBeVisible();
}

test.describe("read aloud ducking", () => {
  test("a read starting and ending asks the ducker to duck and then to restore", async ({
    overlayWindow,
  }) => {
    const before = await reportPlayback(overlayWindow, false);

    const ducked = await reportPlayback(overlayWindow, true);
    expect(
      ducked.duckRequests,
      "a read starting did not reach the ducking module"
    ).toBe(before.duckRequests + 1);
    expect(
      ducked.lastReason,
      "the diagnostic flag did not stop the real PowerShell call"
    ).toBe("diagnostic-flag");
    expect(ducked.duckCalls, "a test run must never change the machine's audio").toBe(0);
    expect(ducked.ducked).toBe(false);

    const restored = await reportPlayback(overlayWindow, false);
    expect(restored.restoreRequests, "a read ending did not reach the ducking module").toBe(
      ducked.restoreRequests + 1
    );
    expect(restored.restoreCalls).toBe(0);
  });

  test("the toggle rides along on the same edge, and off means no duck", async ({
    overlayWindow,
  }) => {
    const before = await reportPlayback(overlayWindow, false);

    // What the overlay sends when "Quiet other apps while reading" is off.
    const off = await reportPlayback(overlayWindow, true, { duckOthers: false });
    expect(off.duckRequests, "the ducker was asked to duck with the toggle off").toBe(
      before.duckRequests
    );

    await reportPlayback(overlayWindow, false);

    // And with it on, on the very next read.
    const on = await reportPlayback(overlayWindow, true, { duckOthers: true });
    expect(on.duckRequests).toBe(before.duckRequests + 1);

    await reportPlayback(overlayWindow, false);
  });

  test.describe("the toggle on the Read Aloud page", () => {
    test.use({ seedKokoroModel: true });

    test("is on by default, is a real setting, and says what it does", async ({
      controlPanel,
    }) => {
      await unlockTesterAccess(controlPanel);
      await openReadAloudPage(controlPanel);

      const row = controlPanel.getByTestId("readaloud-duck-others-row");
      await expect(row).toBeVisible();
      await expect(row.getByText("Quiet other apps while reading", { exact: true })).toBeVisible();
      // The description has to be specific about the number and the way back,
      // not "smart audio management".
      await expect(row).toContainText("30%");
      await expect(row).toContainText("then restores the volume");

      const toggle = row.locator("button");
      await expect(toggle).toBeEnabled();
      // Default on: nothing has been clicked yet.
      await expect(toggle).toHaveClass(/bg-primary/);
      expect(
        await controlPanel.evaluate(() => localStorage.getItem("readAloudDuckOthers"))
      ).toBe("true");

      // The knob slides over 150ms of CSS transition, which is not a Web
      // Animation and so cannot be waited on.
      await controlPanel.waitForTimeout(500);
      await captureEvidence(controlPanel, "readaloud-ducking-toggle.png");

      await toggle.click();
      expect(
        await controlPanel.evaluate(() => localStorage.getItem("readAloudDuckOthers"))
      ).toBe("false");
      await expect(toggle).not.toHaveClass(/bg-primary/);

      await controlPanel.waitForTimeout(500);
      await captureEvidence(controlPanel, "readaloud-ducking-toggle-off.png");
    });
  });
});
