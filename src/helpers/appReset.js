"use strict";

/**
 * Reset app data.
 *
 * The running app cannot delete its own data folder on Windows. The history
 * database, the log file, Chromium's Local Storage and its caches are all open
 * while it runs, and the old recursive delete stopped at the first open file,
 * said nothing and restarted as if the folder were gone. API keys, history,
 * logs and Local Storage, which can hold API keys in plain text, all survived.
 *
 * So a reset has two halves. The running app writes a marker into the data
 * folder, stops the model engines, clears the model caches and restarts. The
 * next start finds the marker and empties the data folder before anything has
 * opened a file in it, then reports exactly what it could not remove.
 *
 * The model caches are cleared by the running app and never at startup: they
 * sit under the home folder, and an e2e run only points that at a throwaway
 * folder once the app is up, so a startup wipe there would hit the real cache.
 */

const fs = require("fs");
const path = require("path");

const RESET_MARKER = ".reset-pending";

/**
 * Held open by this very process from requestSingleInstanceLock() on, and
 * removed by the OS when it exits. `lockfile` is the Windows one.
 */
const LIVE_LOCK_FILES = new Set([
  "lockfile",
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
]);

/** Paths carried in the marker or listed to the user stop here. */
const MAX_REPORTED_PATHS = 50;
const MAX_LISTED_PATHS = 12;

/**
 * Model caches a reset clears: only folders this app created. Privoca and
 * dictatevoice are its earlier names. `~/.cache/whisper` is not on the list.
 * It is Python Whisper's own model folder, which no build of this app wrote
 * to, so a reset there would delete another program's models.
 */
function modelCacheDirs(homeDir) {
  return ["PrivateTranscribe", "Privoca", "dictatevoice"].map((name) =>
    path.join(homeDir, ".cache", name)
  );
}

/**
 * Delete `target` and everything under it, carrying on past anything that will
 * not go, and add each path that is still there to `survivors`. A link or
 * junction is removed itself, never followed out of the folder being wiped.
 */
function removeTree(target, survivors) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error.code !== "ENOENT") survivors.push(target);
    return;
  }

  if (stat.isDirectory()) {
    const before = survivors.length;
    let names;
    try {
      names = fs.readdirSync(target);
    } catch {
      survivors.push(target);
      return;
    }
    for (const name of names) removeTree(path.join(target, name), survivors);
    // A folder that kept a file cannot go either. The file is what gets listed.
    if (survivors.length > before) return;
  }

  try {
    // The retries cover a scanner or indexer holding a file for a moment.
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
  } catch {
    survivors.push(target);
  }
}

function writeMarker(userDataPath, contents) {
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(path.join(userDataPath, RESET_MARKER), JSON.stringify(contents));
}

/** The marker's contents, `{}` when it cannot be parsed, or null when there is none. */
function readMarker(markerPath) {
  let raw;
  try {
    raw = fs.readFileSync(markerPath, "utf8");
  } catch (error) {
    // A marker that exists but cannot be read still means a reset is pending.
    return error.code === "ENOENT" ? null : {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The first half, in the running app.
 *
 * Writing the marker comes first and is the only step that throws, so a reset
 * that could not finish is reported as failed before anything is deleted.
 * `releaseModelFiles` stops the engines that hold model weights open; the
 * caches are cleared after it. Returns the cache paths that could not be
 * removed, which the marker also carries so the next start can list them.
 */
async function requestAppReset({ userDataPath, homeDir, releaseModelFiles }) {
  const requestedAt = new Date().toISOString();
  writeMarker(userDataPath, { requestedAt, cacheSurvivors: [] });

  try {
    await releaseModelFiles?.();
  } catch {
    // Whatever the engines still hold shows up below as a path that survived.
  }

  const cacheSurvivors = [];
  for (const dir of modelCacheDirs(homeDir)) removeTree(dir, cacheSurvivors);

  if (cacheSurvivors.length > 0) {
    try {
      writeMarker(userDataPath, {
        requestedAt,
        cacheSurvivors: cacheSurvivors.slice(0, MAX_REPORTED_PATHS),
      });
    } catch {
      // The data folder still gets emptied; only this list is lost.
    }
  }

  return { cacheSurvivors };
}

/**
 * The second half, at the next start, before Crashpad, Chromium, the database
 * or the logger has opened a file in the data folder. Returns null when no
 * reset is pending, otherwise every path that is still on disk.
 */
function finishPendingReset(userDataPath) {
  const markerPath = path.join(userDataPath, RESET_MARKER);
  const marker = readMarker(markerPath);
  if (!marker) return null;

  const survivors = [];
  let names = [];
  try {
    names = fs.readdirSync(userDataPath);
  } catch {
    survivors.push(userDataPath);
  }
  for (const name of names) {
    if (name === RESET_MARKER || LIVE_LOCK_FILES.has(name)) continue;
    removeTree(path.join(userDataPath, name), survivors);
  }
  // Last, so a start that dies halfway through finishes the job the next time.
  removeTree(markerPath, survivors);

  // Only listed to the user, never deleted: the marker is a file anyone with
  // access to the data folder could have written.
  const cacheSurvivors = Array.isArray(marker.cacheSurvivors)
    ? marker.cacheSurvivors
        .filter((entry) => typeof entry === "string")
        .slice(0, MAX_REPORTED_PATHS)
    : [];

  return { survivors: [...cacheSurvivors, ...survivors] };
}

/** The detail text for the dialog that lists what a reset left behind. */
function describeResetLeftovers(survivors) {
  const listed = survivors.slice(0, MAX_LISTED_PATHS);
  const more = survivors.length - listed.length;
  return [
    "These are still on disk:",
    "",
    ...listed,
    ...(more > 0 ? [`...and ${more} more`] : []),
    "",
    "Close any program that may be using them, then delete them by hand or run Reset app data again.",
  ].join("\n");
}

module.exports = {
  RESET_MARKER,
  modelCacheDirs,
  requestAppReset,
  finishPendingReset,
  describeResetLeftovers,
};
