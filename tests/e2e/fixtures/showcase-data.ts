import type { ElectronApplication } from "@playwright/test";

/**
 * Staged content for the marketing screenshots on the AlternativeTo listing.
 *
 * The numbers and the dictation text are copied from the screenshots already on
 * that listing, captured before 0.16.0. Reusing them keeps the gallery
 * consistent when the images are replaced, so only the UI changes between the
 * old shots and the new ones.
 *
 * None of this is a claim about the product. It is sample history, the same way
 * a screenshot of an email client shows sample mail.
 */
export const SHOWCASE_STATS = {
  total_words: 34892,
  total_transcriptions: 284,
  // formatSpeakingTime floors to whole minutes, so 15120s renders "4h 12m".
  total_seconds: 15120,
  average_wpm: 138,
};

/** Consecutive local days of activity, ending today, behind the "7 days" streak. */
export const SHOWCASE_STREAK_DAYS = 7;

/**
 * `daysAgo` is a LOCAL calendar offset; `hourUtc` is the UTC hour written to the
 * row. The app parses a bare "YYYY-MM-DD HH:MM:SS" as UTC and then reads the
 * local calendar day off it, so an hour in the middle of the UTC day keeps the
 * row on its intended local day for any realistic timezone offset.
 *
 * Grouping on the History page: 0 is Today, 1 is Yesterday, 2-6 are This Week.
 */
export const SHOWCASE_DICTATIONS: { text: string; daysAgo: number; hourUtc: number }[] = [
  {
    text: "Review the authentication flow, identify why the integration tests fail after token refresh, fix the root cause, and run the smallest relevant test suite before committing.",
    daysAgo: 0,
    hourUtc: 16,
  },
  {
    text: "Inspect the current git diff for security issues, accidental scope changes, missing error handling, and tests that do not actually prove the new behavior.",
    daysAgo: 0,
    hourUtc: 14,
  },
  {
    text: "Create a twenty-five second vertical clip from the strongest moment, keep the hook inside the first two seconds, add readable captions, and reject it if the source context becomes misleading.",
    daysAgo: 1,
    hourUtc: 18,
  },
  {
    text: "Trace the renderer crash from the user-visible symptom back through the IPC handler, reproduce it with a focused test, and fix the underlying state mismatch rather than adding another fallback.",
    daysAgo: 2,
    hourUtc: 17,
  },
  {
    text: "Refactor the transcription pipeline so local Whisper remains the default, cloud transcription stays optional, and the settings copy never implies that audio always remains on the device.",
    daysAgo: 2,
    hourUtc: 11,
  },
  {
    text: "Draft the release notes for this version from the commit log, group them by what a user would actually notice, and leave out anything that only matters to the build.",
    daysAgo: 3,
    hourUtc: 15,
  },
  {
    text: "Work out why the first press of the hotkey is slower than every press after it, measure it properly before changing anything, and tell me whether the warm-up is the real cause.",
    daysAgo: 3,
    hourUtc: 9,
  },
  {
    text: "Go through the onboarding copy and take out every promise the app cannot keep on a machine without a GPU.",
    daysAgo: 4,
    hourUtc: 13,
  },
  {
    text: "Find the places where a failed download leaves a half-written file on disk, and make each one clean up after itself.",
    daysAgo: 5,
    hourUtc: 16,
  },
  {
    text: "Summarise what changed in the audio pipeline this week in plain language, short enough to paste straight into a changelog entry.",
    daysAgo: 6,
    hourUtc: 10,
  },
];

/** "YYYY-MM-DD" for a local calendar day `daysAgo` before today. */
function localDateKey(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const stamp = (daysAgo: number, hourUtc: number, minute: number) =>
  `${localDateKey(daysAgo)} ${String(hourUtc).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;

/**
 * Write the staged history into the running app's database.
 *
 * better-sqlite3 in this repo is built against Electron's ABI, so it cannot be
 * required from the Playwright process. The write therefore runs inside the
 * main process, which already has a matching binary loaded, against a second
 * connection to the same file. The app is idle while this runs.
 *
 * Call before the renderer reads the data, then reload the control panel.
 */
export async function seedShowcaseDatabase(electronApp: ElectronApplication): Promise<void> {
  const rows = SHOWCASE_DICTATIONS.map((entry, index) => ({
    text: entry.text,
    timestamp: stamp(entry.daysAgo, entry.hourUtc, (index * 7) % 60),
  }));

  const streak = Array.from({ length: SHOWCASE_STREAK_DAYS }, (_, offset) => ({
    local_date: localDateKey(offset),
    timestamp: stamp(offset, 12, 0),
  }));

  const failure = await electronApp.evaluate(
    async ({ app }, payload) => {
      // The evaluated function runs in the main process but not inside a module
      // scope, so neither `require` nor dynamic `import()` is available here.
      // The CommonJS entry point's own require is, and it resolves
      // better-sqlite3 to the Electron-ABI build already loaded in this process.
      const mainModule = (process as unknown as { mainModule?: NodeJS.Module }).mainModule;
      const appRequire =
        mainModule?.require?.bind(mainModule) ??
        (globalThis as unknown as { require?: NodeRequire }).require;
      if (typeof appRequire !== "function") {
        return "no require available in the main process";
      }
      const nodePath = appRequire("node:path");
      // Resolution runs with Electron's own module as the require stack root, so
      // a bare specifier does not find the app's dependencies. An absolute path
      // into the app's node_modules does, and it is the same Electron-ABI build
      // the app itself loaded.
      const Database = appRequire(
        nodePath.join(app.getAppPath(), "node_modules", "better-sqlite3")
      );
      const file = nodePath.join(app.getPath("userData"), "transcriptions.db");
      const db = new Database(file);
      try {
        db.exec("DELETE FROM transcriptions");
        db.exec("DELETE FROM streak_activity");

        const insert = db.prepare(
          "INSERT INTO transcriptions (text, timestamp, created_at, include_in_stats) VALUES (?, ?, ?, 1)"
        );
        // Oldest first, so the autoincrement ids run in the same direction as
        // the timestamps and the "Recent dictations" numbering reads 1, 2, 3.
        for (const row of [...payload.rows].reverse()) {
          insert.run(row.text, row.timestamp, row.timestamp);
        }

        const streakInsert = db.prepare(
          "INSERT INTO streak_activity (local_date, timestamp) VALUES (?, ?)"
        );
        for (const day of payload.streak) streakInsert.run(day.local_date, day.timestamp);

        // initDatabase already inserted the id=1 row, so this is an update.
        db.prepare(
          "UPDATE stats SET total_words = ?, total_transcriptions = ?, total_seconds = ?, average_wpm = ? WHERE id = 1"
        ).run(
          payload.stats.total_words,
          payload.stats.total_transcriptions,
          payload.stats.total_seconds,
          payload.stats.average_wpm
        );
        return null;
      } catch (error) {
        return String((error as Error)?.message ?? error);
      } finally {
        db.close();
      }
    },
    { rows, streak, stats: SHOWCASE_STATS }
  );

  if (failure) throw new Error(`seedShowcaseDatabase failed inside the app: ${failure}`);
}
