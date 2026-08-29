"use strict";

/**
 * Local crash capture.
 *
 * On 2026-08-30 the main process died with 0xC000041D — a fatal exception
 * inside a Windows user-mode callback (a window proc or a hook proc) — after
 * 53 hours of uptime. Windows kept a bucket ID and purged the minidump before
 * anyone could look at it, so all that survived was "it died somewhere in a
 * callback". No stack, no line, nothing to fix.
 *
 * Crashpad writes a real minidump every time, right next to the app's own data.
 * `uploadToServer: false` is not a default to rely on being harmless — it is the
 * point. Nothing is sent anywhere. The dump sits on the user's disk until they
 * or a support request do something with it, which is the only behaviour this
 * product can honestly ship.
 *
 * `ignoreSystemCrashHandler` stays false so Windows Error Reporting still logs
 * its Application Error event. That event is what makes a crash findable at all
 * when a user says "it closed itself an hour ago".
 */

const fs = require("fs");
const path = require("path");

/** Keep the most recent few and delete the rest; Electron minidumps are large. */
const MAX_RETAINED_DUMPS = 5;

let started = false;

/**
 * Start Crashpad. Must run before the first window and before app.whenReady(),
 * so a crash during startup — the riskiest part — is still captured.
 *
 * Never throws: a missing crash handler must not be the reason the app fails to
 * launch.
 */
function startCrashCapture() {
  if (started) return true;

  try {
    const { crashReporter } = require("electron");
    crashReporter.start({
      // No submitURL: with uploadToServer false there is nowhere to submit to,
      // and naming a URL we never call would be misleading to anyone reading it.
      uploadToServer: false,
      compress: true,
      ignoreSystemCrashHandler: false,
    });
    started = true;
    return true;
  } catch (error) {
    // Logged by the caller, which owns the logger.
    throw error;
  }
}

/** Where Crashpad puts the dumps. Null before the app is ready. */
function getCrashDumpDirectory() {
  try {
    const { app } = require("electron");
    return path.join(app.getPath("crashDumps"), "reports");
  } catch {
    return null;
  }
}

function listDumps(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".dmp"))
    .map((entry) => {
      const full = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(full);
        return { path: full, name: entry.name, bytes: stat.size, modified: stat.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.modified - a.modified);
}

/**
 * Report whatever the previous session left behind and prune the backlog.
 *
 * Call after app.whenReady() — app.getPath("crashDumps") is not resolvable
 * before that. Returns a summary rather than logging directly so the caller can
 * decide how loud to be about it.
 *
 * `directory` is a test seam so this can be exercised without an Electron app.
 */
function collectPreviousCrashes({ maxRetained = MAX_RETAINED_DUMPS, directory } = {}) {
  const dir = directory || getCrashDumpDirectory();
  if (!dir) {
    return { directory: null, dumps: [], pruned: 0 };
  }

  const dumps = listDumps(dir);

  let pruned = 0;
  for (const dump of dumps.slice(maxRetained)) {
    try {
      fs.unlinkSync(dump.path);
      pruned += 1;
    } catch {
      // A dump we cannot delete is not worth failing startup over; it will be
      // retried next launch.
    }
  }

  return {
    directory: dir,
    dumps: dumps.slice(0, maxRetained).map((dump) => ({
      name: dump.name,
      bytes: dump.bytes,
      at: new Date(dump.modified).toISOString(),
    })),
    pruned,
  };
}

module.exports = {
  MAX_RETAINED_DUMPS,
  startCrashCapture,
  getCrashDumpDirectory,
  collectPreviousCrashes,
};
