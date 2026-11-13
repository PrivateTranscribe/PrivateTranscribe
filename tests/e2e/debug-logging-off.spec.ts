import fs from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";

/**
 * Turning Debug logging off has to end the log file.
 *
 * It used to lower the log level and leave the file open, so info, warning and
 * error lines kept landing in it until the app was restarted, dictated text
 * included.
 *
 * The Debug mode switch only shows in a development run (`npm run dev`). This
 * spec makes the call that switch makes, against the real handler, logger and
 * file.
 */

type DebugState = { enabled: boolean; logPath: string | null };

const setDebugLogging = (page: Page, enabled: boolean) =>
  page.evaluate(
    (value) => (window as unknown as { electronAPI: any }).electronAPI.setDebugLogging(value),
    enabled
  );

const debugState = (page: Page): Promise<DebugState> =>
  page.evaluate(() => (window as unknown as { electronAPI: any }).electronAPI.getDebugState());

/** An info line the way any window sends one to the main process's logger. */
const logInfoLine = (page: Page, message: string) =>
  page.evaluate(
    (text) =>
      (window as unknown as { electronAPI: any }).electronAPI.log({
        level: "info",
        message: text,
        scope: "e2e",
        source: "renderer",
      }),
    message
  );

test("the log file gets no more lines once Debug logging is off", async ({ controlPanel }) => {
  const turnedOn = await setDebugLogging(controlPanel, true);
  expect(turnedOn.success).toBe(true);
  const firstFile = turnedOn.logPath as string;
  expect(firstFile, "turning Debug logging on opened no log file").toBeTruthy();

  await logInfoLine(controlPanel, "line written while debug logging is on");
  await expect
    .poll(() => fs.readFileSync(firstFile, "utf8"), { timeout: 10_000 })
    .toContain("line written while debug logging is on");

  const turnedOff = await setDebugLogging(controlPanel, false);
  expect(turnedOff.success).toBe(true);
  expect((await debugState(controlPanel)).logPath).toBeNull();

  await logInfoLine(controlPanel, "line written after debug logging was turned off");
  await controlPanel.waitForTimeout(1_500);
  expect(fs.readFileSync(firstFile, "utf8")).not.toContain(
    "line written after debug logging was turned off"
  );

  // On again starts a new file and leaves the ended one alone.
  const sizeWhenEnded = fs.statSync(firstFile).size;
  const turnedOnAgain = await setDebugLogging(controlPanel, true);
  const secondFile = turnedOnAgain.logPath as string;
  expect(secondFile).toBeTruthy();
  expect(secondFile).not.toBe(firstFile);

  await logInfoLine(controlPanel, "line written to the second file");
  await expect
    .poll(() => fs.readFileSync(secondFile, "utf8"), { timeout: 10_000 })
    .toContain("line written to the second file");
  expect(fs.statSync(firstFile).size).toBe(sizeWhenEnded);
});
