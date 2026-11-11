import fs from "node:fs";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";
import {
  catchInstance,
  configureLocalWhisperDictation,
  historyTexts,
  readMainLog,
  readPastes,
  recordingHalo,
  recordPastes,
  tapMainLog,
  toggleDictation,
} from "./fixtures/app-drive";

/**
 * A history that cannot be read shows as empty, and the app keeps working.
 *
 * The control panel used to stop at "Something went wrong" on every start once
 * the history could not be read from the database: it opens on Dashboard, and
 * Dashboard crashed on what the main process answered. Settings could not be
 * reached either.
 *
 * One profile, two starts, as a user with a damaged file would have it. The
 * first start dictates once, so the history holds a row. With the app closed,
 * the first page of the history table in `transcriptions.db`, which holds that
 * row, is overwritten with zeros. The file still opens and the statistics
 * table still reads, but any read of the history ends in "database disk image
 * is malformed".
 */

const FIXTURE_DIR = path.resolve(__dirname, "..", "fixtures", "dictation");

test.use({
  fakeAudioCaptureFile: path.join(FIXTURE_DIR, "banana.wav"),
  seedRealWhisperModels: ["base"],
  appEnv: { WHISPER_FORCE_CPU: "true" },
});

type LiveDatabase = { __ptE2eLive: Record<string, any> };

/** Two passes of the six-second clip, so one whole sentence is always in it. */
async function dictate(app: ElectronApplication, overlay: Page, pasteNumber: number) {
  await toggleDictation(app);
  await expect(recordingHalo(overlay)).toHaveCount(1, { timeout: 30_000 });
  await overlay.waitForTimeout(12_000);
  await toggleDictation(app);
  await expect
    .poll(async () => (await readPastes(app)).length, { timeout: 120_000 })
    .toBe(pasteNumber);
  return (await readPastes(app))[pasteNumber - 1].text;
}

/** The app's own database object, caught on its next history read. */
async function catchDatabase(app: ElectronApplication, page: Page): Promise<void> {
  await catchInstance(app, {
    key: "database",
    modulePath: "src/helpers/database.js",
    method: "getTranscriptions",
  });
  await historyTexts(page);
}

/** Where the history rows start in the file: the table's first page. */
function historyPage(app: ElectronApplication): Promise<{ pageSize: number; rootPage: number }> {
  return app.evaluate(() => {
    const db = (globalThis as unknown as LiveDatabase).__ptE2eLive.database.db;
    return {
      pageSize: db.pragma("page_size", { simple: true }),
      rootPage: db
        .prepare("SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("transcriptions").rootpage,
    };
  });
}

/** What a read of one table answers when asked directly: its rows, or its error. */
function readDirectly(app: ElectronApplication, table: "transcriptions" | "stats") {
  return app.evaluate((_electron, name) => {
    const database = (globalThis as unknown as LiveDatabase).__ptE2eLive.database;
    try {
      return `rows: ${database.db.prepare(`SELECT * FROM ${name}`).all().length}`;
    } catch (error) {
      return `error: ${(error as Error).message}`;
    }
  }, table);
}

const failedHistoryCalls = async (app: ElectronApplication, call: string) =>
  (await readMainLog(app)).filter(
    (line) => line.message.includes(call) && line.detail.includes("malformed")
  ).length;

test("a history that cannot be read shows as empty and the app keeps working", async ({
  electronApp,
  overlayWindow,
  controlPanel,
  userDataDir,
  relaunchElectronApp,
}) => {
  test.setTimeout(420_000);

  // First start: one dictation, so there is a history to lose sight of.
  await recordPastes(electronApp);
  await configureLocalWhisperDictation(overlayWindow);
  expect((await dictate(electronApp, overlayWindow, 1)).toLowerCase()).toContain("banana");
  await expect.poll(async () => (await historyTexts(controlPanel)).length).toBe(1);

  await catchDatabase(electronApp, controlPanel);
  const { pageSize, rootPage } = await historyPage(electronApp);
  expect(rootPage, "the history table's first page is the schema page").toBeGreaterThan(1);

  const databaseFile = path.join(userDataDir, "transcriptions.db");
  const restarted = await relaunchElectronApp({
    whileClosed: () => {
      const offset = (rootPage - 1) * pageSize;
      test.info().annotations.push({
        type: "damage",
        description: `page ${rootPage} of transcriptions.db zeroed: ${pageSize} bytes from byte ${offset}`,
      });
      expect(fs.statSync(databaseFile).size).toBeGreaterThanOrEqual(offset + pageSize);
      const file = fs.openSync(databaseFile, "r+");
      try {
        fs.writeSync(file, Buffer.alloc(pageSize), 0, pageSize, offset);
      } finally {
        fs.closeSync(file);
      }
    },
  });
  const app = restarted.electronApp;
  const panel = restarted.controlPanel;
  const overlay = restarted.overlayWindow!;

  // The damage is real: the file opened, the history cannot be read, and the
  // rest of the file can. This read is answered after the one the control
  // panel made while loading, so the panel has its answer by now.
  await tapMainLog(app);
  await catchDatabase(app, panel);
  expect(await readDirectly(app, "transcriptions")).toBe("error: database disk image is malformed");
  expect(await readDirectly(app, "stats")).toBe("rows: 1");
  expect(
    await failedHistoryCalls(app, "db-get-transcriptions"),
    "the app's own history read did not fail"
  ).toBeGreaterThan(0);

  // The control panel opened on Dashboard, not on the crash screen.
  await expect(panel.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  await expect(panel.getByText("Something went wrong", { exact: true })).toHaveCount(0);

  // History shows as empty.
  await panel.getByRole("button", { name: "History", exact: true }).click();
  await expect(panel.getByText("No transcriptions yet", { exact: true })).toBeVisible();

  // Settings can be reached.
  await panel.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();

  // A new dictation is still transcribed and pasted.
  await recordPastes(app);
  await configureLocalWhisperDictation(overlay);
  expect((await dictate(app, overlay, 1)).toLowerCase()).toContain("banana");

  // The damaged file takes no new rows either: the save of that dictation
  // fails, and History still shows as empty.
  await expect
    .poll(() => failedHistoryCalls(app, "db-save-transcription"), {
      message: "the save of the new dictation did not fail",
    })
    .toBeGreaterThan(0);
  expect(await historyTexts(panel)).toEqual([]);

  // And the control panel is still standing after it.
  await panel.getByRole("button", { name: "Home", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  await expect(panel.getByText("Something went wrong", { exact: true })).toHaveCount(0);
});
