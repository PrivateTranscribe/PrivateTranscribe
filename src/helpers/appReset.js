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

/**
 * What the two volume duckers write before they lower anything, so the next
 * start can put the volume back. A reset pressed mid-dictation or mid-read can
 * quit before that restore lands, so the wipe leaves these for the startup
 * repair, which reads and deletes them. They hold volume levels, nothing of the
 * user's. The names match STATE_FILE_NAME in audioDuckingManager.js and
 * readAloudDucking.js; those modules are not safe to load this early.
 */
const KEPT_FOR_VOLUME_REPAIR = new Set(["audio-ducking-state.json", "readaloud-ducking-state.txt"]);

/** Paths carried in the marker or listed to the user stop here. */
const MAX_REPORTED_PATHS = 50;
const MAX_LISTED_PATHS = 12;

/** Errors worth another try: a scanner, an indexer or a process on its way out. */
const RETRY_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE", "ENFILE"]);
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 50;
/** All the waiting one reset may do, so a folder of locked files cannot hang it. */
const RETRY_BUDGET_MS = 2000;

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

/** One delete pass: what is still on disk, and how much waiting is left. */
function startPass() {
  return { survivors: [], retryBudgetMs: RETRY_BUDGET_MS };
}

function pause(pass, ms) {
  const wait = Math.min(ms, pass.retryBudgetMs);
  if (wait <= 0) return false;
  pass.retryBudgetMs -= wait;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  return true;
}

/**
 * Run one single-entry delete, trying again briefly on errors that pass. Never
 * throws: the caller checks the disk afterwards, which is the only answer that
 * counts. `clearReadOnly` is for real files and folders only, because chmod
 * follows a link to its target.
 */
function attemptRemoval(remove, target, pass, { clearReadOnly }) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      remove();
      return;
    } catch (error) {
      if (error.code === "ENOENT") return;
      if (!RETRY_CODES.has(error.code) || attempt === MAX_ATTEMPTS) return;
      if (error.code === "EPERM" && clearReadOnly) {
        try {
          fs.chmodSync(target, 0o666);
        } catch {
          // The next attempt fails the same way, and the check reports it.
        }
      }
      if (!pause(pass, RETRY_DELAY_MS * attempt)) return;
    }
  }
}

function isOnDisk(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    return error.code !== "ENOENT";
  }
}

function realPathOf(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return null;
  }
}

function samePath(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Delete `target` and everything under it, carrying on past anything that will
 * not go, and add each path that is still on disk afterwards to the pass.
 *
 * Every call deletes exactly one entry: unlink for a file or a link, rmdir for
 * an emptied folder. A link or junction is removed itself and never followed.
 * fs.rmSync with `recursive` is never used: on the Node that Electron ships it
 * follows a junction and empties the folder it points to, then reports success.
 *
 * `realParent` is the real path of the folder `target` sits in. A folder whose
 * own real path is anywhere else is a link that lstat did not report as one,
 * such as a mount point, so it is not descended into either.
 */
function removeTree(target, pass, realParent = realPathOf(path.dirname(target))) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error.code !== "ENOENT") pass.survivors.push(target);
    return;
  }

  if (stat.isDirectory()) {
    const realTarget = realPathOf(target);
    const expected = realParent && path.join(realParent, path.basename(target));
    const isRealFolder = realTarget && expected && samePath(realTarget, expected);

    if (isRealFolder) {
      const before = pass.survivors.length;
      let names = null;
      try {
        names = fs.readdirSync(target);
      } catch {
        // Cannot look inside, so it cannot be emptied. Listed below.
      }
      if (names) {
        for (const name of names) removeTree(path.join(target, name), pass, realTarget);
      }
      // A folder that kept a file cannot go either. The file is what gets listed.
      if (pass.survivors.length > before) return;
    }
    // rmdir never recurses. For a folder that leads elsewhere it removes the
    // entry itself, or fails and the folder is listed.
    attemptRemoval(() => fs.rmdirSync(target), target, pass, {
      clearReadOnly: Boolean(isRealFolder),
    });
  } else {
    // A file, or a link of any kind: unlink removes the entry, never its target.
    attemptRemoval(() => fs.unlinkSync(target), target, pass, {
      clearReadOnly: !stat.isSymbolicLink(),
    });
    // Some Windows setups refuse to unlink a directory symlink; rmdir removes
    // that link the same way and never recurses.
    if (stat.isSymbolicLink() && isOnDisk(target)) {
      attemptRemoval(() => fs.rmdirSync(target), target, pass, { clearReadOnly: false });
    }
  }

  // What the calls above said is not the answer; what is still on disk is.
  if (isOnDisk(target)) pass.survivors.push(target);
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

  const pass = startPass();
  for (const dir of modelCacheDirs(homeDir)) removeTree(dir, pass);
  const cacheSurvivors = pass.survivors;

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

  const pass = startPass();
  const realUserData = realPathOf(userDataPath);
  let names = [];
  try {
    names = fs.readdirSync(userDataPath);
  } catch {
    pass.survivors.push(userDataPath);
  }
  for (const name of names) {
    if (name === RESET_MARKER || LIVE_LOCK_FILES.has(name)) continue;
    if (KEPT_FOR_VOLUME_REPAIR.has(name)) continue;
    removeTree(path.join(userDataPath, name), pass, realUserData);
  }
  // Last, so a start that dies halfway through finishes the job the next time.
  removeTree(markerPath, pass, realUserData);

  // Only listed to the user, never deleted: the marker is a file anyone with
  // access to the data folder could have written. A model file the engines
  // still held when the reset was asked for may have gone since, so only what
  // is still there is listed.
  const cacheSurvivors = Array.isArray(marker.cacheSurvivors)
    ? marker.cacheSurvivors
        .filter((entry) => typeof entry === "string")
        .slice(0, MAX_REPORTED_PATHS)
        .filter(isOnDisk)
    : [];

  return { survivors: [...cacheSurvivors, ...pass.survivors] };
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
