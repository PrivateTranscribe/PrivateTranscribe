"use strict";

/**
 * VoiceMuter - holds a voice app's push-to-mute key for the length of a
 * dictation.
 *
 * Runs windows-hold-key.exe, which presses the configured combination, holds
 * it while dictation is in progress, and releases it afterwards.
 *
 * Two rules govern everything here:
 *
 *   Only undo what we did. If we never managed to mute, release() does
 *   nothing, so we can never unmute someone who muted themselves.
 *
 *   When in doubt, stay muted. A failure to release leaves the user silent,
 *   which is recoverable. A spurious release broadcasts them, which is not.
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const debugLogger = require("./debugLogger");

const HOLD_KEY_EXECUTABLE = "windows-hold-key.exe";

// Safety net inside the helper. A dictation longer than this releases the mute
// key on its own rather than leaving the user muted indefinitely.
const DEFAULT_MAX_HOLD_MS = 10 * 60 * 1000;

// The helper prints "held" once the key is down. If that never arrives,
// something is wrong and we must not report a successful mute.
const HELD_TIMEOUT_MS = 2000;
const RELEASE_TIMEOUT_MS = 2000;

/**
 * Written in userData before the helper starts and deleted once the key is
 * known to be up. A file still there at startup means a run ended with the key
 * possibly down (the helper killed outright, the PC losing power), so startup
 * sends the key-up for the key it names.
 */
const HELD_MARKER_FILE_NAME = "voice-mute-held.json";

// The helper's exit codes that leave no key down: 0 after its own release, 2
// and 3 for a missing or unparseable --key before anything is pressed. Any
// other end, a kill included, skipped the key-up.
const CLEAN_HELPER_EXIT_CODES = new Set([0, 2, 3]);

function getHoldKeyExecutablePaths({
  resourcesPath = process.resourcesPath,
  cwd = process.cwd(),
  helpersDir = __dirname,
} = {}) {
  const candidates = [];
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, "bin", HOLD_KEY_EXECUTABLE));
  }
  candidates.push(
    path.join(helpersDir, "..", "..", "resources", "bin", HOLD_KEY_EXECUTABLE),
    path.join(cwd, "resources", "bin", HOLD_KEY_EXECUTABLE)
  );
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

function resolveHoldKeyExecutable(options = {}) {
  const { existsSync = fs.existsSync, ...pathOptions } = options;
  const found = getHoldKeyExecutablePaths(pathOptions).find((candidate) => {
    try {
      return existsSync(candidate);
    } catch {
      return false;
    }
  });
  return found || null;
}

/**
 * Resolves true once the helper prints "held", false if it exits or stays
 * quiet past `timeoutMs`.
 */
function waitForHeld(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("held")) {
        finish(true);
      }
    });
    child.on("error", () => finish(false));
    child.on("close", () => finish(false));
  });
}

/**
 * Asks the helper to let go: a "release" line, then stdin closed. The helper
 * reads stdin only once the key is down, so this works on one still starting.
 */
function writeRelease(child) {
  try {
    if (!child.stdin.writableEnded) {
      child.stdin.write("release\n");
      child.stdin.end();
    }
    return true;
  } catch {
    return false;
  }
}

const SPAWN_FAILED = "spawn-failed";
const TIMED_OUT = "timed-out";

function isCleanExit(code) {
  // A helper that never started pressed nothing.
  return code === SPAWN_FAILED || CLEAN_HELPER_EXIT_CODES.has(code);
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

class VoiceMuter {
  /**
   * `spawn` and `resolveExecutable` are injectable because vitest cannot mock
   * a require inside src/helpers, and a unit test must never press a real key.
   */
  constructor({
    spawn: spawnHelper = spawn,
    resolveExecutable = resolveHoldKeyExecutable,
    heldTimeoutMs = HELD_TIMEOUT_MS,
    releaseTimeoutMs = RELEASE_TIMEOUT_MS,
  } = {}) {
    this.isSupported = process.platform === "win32";
    this.process = null;
    this.heldKey = null;
    // A hold whose helper is running but has not printed "held" yet.
    this.pending = null;
    this._session = null;
    // The previous helper's release, while it is still letting go.
    this._releasing = null;
    this._spawn = spawnHelper;
    this._resolveExecutable = resolveExecutable;
    this._heldTimeoutMs = heldTimeoutMs;
    this._releaseTimeoutMs = releaseTimeoutMs;
    this._markerPath = null;
    this._markerSeq = 0;
    this._markerId = null;
  }

  /** Late-bind the userData dir for the held-key marker, which only main.js knows. */
  configure({ userDataPath } = {}) {
    if (userDataPath) {
      this._markerPath = path.join(userDataPath, HELD_MARKER_FILE_NAME);
    }
    return this._markerPath;
  }

  isMuted() {
    return this.process !== null;
  }

  /**
   * Presses and holds `key`. Resolves true only once the helper has confirmed
   * the key is actually down, so callers can tell a real mute from a silent
   * failure.
   */
  async hold(key, maxHoldMs = DEFAULT_MAX_HOLD_MS) {
    if (!this.isSupported || !key) {
      return false;
    }

    if (this.process) {
      // Already holding. Never stack a second press on top: the release would
      // not balance and the key could be left down.
      return true;
    }
    if (this.pending) {
      // Same rule while the first helper is still starting, unless that hold
      // is already being let go of. Sharing it then would report a mute for a
      // key that is on its way up, so this dictation waits for its own press.
      if (!this.pending.releaseRequested) {
        return this.pending.result;
      }
      await this.pending.result;
      return this.hold(key, maxHoldMs);
    }
    if (this._releasing) {
      // The last helper is still letting go. A press started now could land
      // before its key-up and be cancelled by it.
      await this._releasing;
      return this.hold(key, maxHoldMs);
    }

    const executable = this._resolveExecutable();
    if (!executable) {
      debugLogger.debug("voiceMuter: helper not found, auto-mute unavailable");
      return false;
    }

    // Before the spawn: the key can go down any time after it.
    const markerId = this._writeMarker(key);

    let child;
    try {
      child = this._spawn(executable, [`--key=${key}`, `--max-ms=${maxHoldMs}`], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this._clearMarker(markerId);
      debugLogger.warn("voiceMuter: failed to spawn helper", { error: error.message });
      return false;
    }
    // A write to a helper that already exited fails asynchronously on the
    // stream. Unhandled, that error would take down the main process.
    child.stdin.on("error", () => {});

    const session = {
      child,
      key,
      markerId,
      maxHoldMs,
      startedAt: Date.now(),
      safetyTimer: null,
      releaseRequested: false,
      done: false,
      code: null,
      result: null,
    };
    session.exited = new Promise((resolve) => {
      const settle = (code) => {
        if (session.done) return;
        session.done = true;
        session.code = code;
        resolve(code);
      };
      child.on("close", (code) => settle(code));
      child.on("error", () => settle(SPAWN_FAILED));
    });

    this.pending = session;
    session.result = this._confirmHold(session);
    return session.result;
  }

  async _confirmHold(session) {
    const { child, key } = session;
    const held = await waitForHeld(child, this._heldTimeoutMs);
    if (this.pending === session) {
      this.pending = null;
    }

    if (!held) {
      // The helper may still press late, so it is asked to let go before
      // anything harder is tried.
      await this._letGo(session);
      debugLogger.warn("voiceMuter: helper did not confirm the key was held", { key });
      return false;
    }

    if (session.releaseRequested) {
      // The dictation ended before the helper was up, as on a quick tap. The
      // release line is already waiting on its stdin, so it lets go as soon as
      // it reads it. Wait for that, then report the mute as done: the key did
      // go down, and false would warn that the call heard the dictation.
      await this._letGo(session);
      debugLogger.debug("voiceMuter: released mute key straight after the hold", { key });
      return true;
    }

    this.process = child;
    this.heldKey = key;
    this._session = session;
    session.exited.then((code) => {
      if (this.process !== child) return;
      if (isCleanExit(code)) {
        // It let go on its own after its max-hold timeout. Forget it so a
        // later release() does not write to a dead pipe.
        this.process = null;
        this.heldKey = null;
        this._session = null;
        void this._afterExit(session, code);
        return;
      }
      // It crashed with the key still down, so the call is still muted. When
      // in doubt, stay muted: the key-up waits for this dictation's own
      // release(), or for the max hold the helper would have kept.
      debugLogger.warn("voiceMuter: helper ended mid-hold, key-up waits for the release", {
        key,
        code,
      });
      const remainingMs = Math.max(0, session.maxHoldMs - (Date.now() - session.startedAt));
      session.safetyTimer = setTimeout(() => {
        if (this._session === session) void this.release();
      }, remainingMs);
      session.safetyTimer.unref?.();
    });

    debugLogger.debug("voiceMuter: holding mute key", { key });
    return true;
  }

  /**
   * Releases a key we are holding. Does nothing if we never held one, which is
   * what keeps us from unmuting somebody who muted themselves.
   *
   * A release that arrives while the helper is still starting is not dropped.
   * Dropping it left a quick tap holding the mute key for the helper's full
   * 10-minute limit.
   */
  async release() {
    const pending = this.pending;
    if (!this.process && pending) {
      pending.releaseRequested = true;
      writeRelease(pending.child);
      await pending.result;
      return true;
    }

    const child = this.process;
    const session = this._session;
    if (!child || !session) {
      return false;
    }

    this.process = null;
    const key = this.heldKey;
    this.heldKey = null;
    this._session = null;
    clearTimeout(session.safetyTimer);

    await this._letGo(session);

    debugLogger.debug("voiceMuter: released mute key", { key });
    return true;
  }

  /** _finishHelper, published as _releasing so a new hold waits for it. */
  async _letGo(session) {
    const finishing = this._finishHelper(session);
    this._releasing = finishing;
    try {
      await finishing;
    } finally {
      if (this._releasing === finishing) {
        this._releasing = null;
      }
    }
  }

  /**
   * Asks the helper to let go and waits for it to exit. Only a helper that
   * ignores both the release line and its closed stdin is killed, and as a
   * kill skips its key-up, the key-up is then sent on its own.
   */
  async _finishHelper(session) {
    let code = session.done ? session.code : null;
    if (!session.done) {
      writeRelease(session.child);
      code = await withTimeout(session.exited, this._releaseTimeoutMs);
      if (code === TIMED_OUT) {
        try {
          session.child.kill();
        } catch {
          // Already gone.
        }
        code = null;
      }
    }
    await this._afterExit(session, code);
  }

  /** Clears the marker once the key is known to be up, sending the key-up if needed. */
  async _afterExit(session, code) {
    if (isCleanExit(code)) {
      this._clearMarker(session.markerId);
      return;
    }
    if (this._newerHoldOwns(session)) {
      // A later dictation holds the same key now. A key-up would unmute its
      // call mid-dictation, and its own release sends one at the end anyway.
      debugLogger.debug("voiceMuter: skipped key-up, a newer hold owns the key", {
        key: session.key,
      });
      this._clearMarker(session.markerId);
      return;
    }
    debugLogger.warn("voiceMuter: helper ended without its key-up, sending it", {
      key: session.key,
      code,
    });
    if (await this.clearStuckKey(session.key)) {
      this._clearMarker(session.markerId);
    }
    // Otherwise the marker stays for the next start to try again.
  }

  _newerHoldOwns(session) {
    const holding = this._session && this._session !== session ? this._session : null;
    const starting = this.pending && this.pending !== session ? this.pending : null;
    return [holding, starting].some((other) => other && other.key === session.key);
  }

  _writeMarker(key) {
    if (!this._markerPath) return null;
    const id = ++this._markerSeq;
    try {
      fs.writeFileSync(
        this._markerPath,
        JSON.stringify({ key, writtenAt: new Date().toISOString() }),
        "utf8"
      );
      this._markerId = id;
      return id;
    } catch (error) {
      debugLogger.warn("voiceMuter: could not write the held-key marker", {
        error: error.message,
      });
      return null;
    }
  }

  _clearMarker(id) {
    // A newer hold owns the file now; leave it.
    if (id === null || id !== this._markerId) return;
    this._markerId = null;
    try {
      fs.unlinkSync(this._markerPath);
    } catch {
      // Already gone.
    }
  }

  /**
   * Sends the key-up half on its own, clearing a key a crash or a kill left
   * logically down. Safe to call for a key that is already up. Resolves true
   * once the helper reports it sent the key-up.
   */
  clearStuckKey(key) {
    if (!this.isSupported || !key) {
      return Promise.resolve(false);
    }
    const executable = this._resolveExecutable();
    if (!executable) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      let child;
      try {
        child = this._spawn(executable, [`--key=${key}`, "--release-only"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } catch (error) {
        debugLogger.warn("voiceMuter: failed to clear stuck key", { error: error.message });
        resolve(false);
        return;
      }
      let settled = false;
      const finish = (cleared) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (cleared) debugLogger.debug("voiceMuter: cleared any stuck mute key", { key });
        resolve(cleared);
      };
      const timer = setTimeout(() => finish(false), this._releaseTimeoutMs);
      child.on("error", () => finish(false));
      child.on("close", (code) => finish(code === 0));
    });
  }

  /**
   * Startup half of the marker. A marker left by the last run means its
   * helper may have ended with the key down: a kill from Task Manager, a
   * crash, power lost mid-dictation. A modifier stuck down would corrupt
   * everything the user types, so the key-up goes out once and the marker is
   * deleted either way. A key the helper cannot release now will not release
   * on the next start either.
   */
  async recoverStuckKey() {
    if (!this._markerPath) return false;
    let raw;
    try {
      raw = fs.readFileSync(this._markerPath, "utf8");
    } catch {
      // No marker: the last run ended with the key up.
      return false;
    }
    let marker = null;
    try {
      marker = JSON.parse(raw);
    } catch {
      // Unreadable, so it names no key. It is still deleted below, or every
      // start would trip over it again.
    }
    const key = typeof marker?.key === "string" ? marker.key : null;
    // Same rule as after a kill: never release a key a dictation holds now.
    const ownedNow = key && this._newerHoldOwns({ key });
    const cleared = key && !ownedNow ? await this.clearStuckKey(key) : false;
    // A dictation that started meanwhile has written its own marker.
    if (this._markerId === null) {
      try {
        fs.unlinkSync(this._markerPath);
      } catch {
        // Already gone.
      }
    }
    return cleared;
  }
}

module.exports = new VoiceMuter();
module.exports.VoiceMuter = VoiceMuter;
module.exports.getHoldKeyExecutablePaths = getHoldKeyExecutablePaths;
module.exports.resolveHoldKeyExecutable = resolveHoldKeyExecutable;
module.exports.HELD_MARKER_FILE_NAME = HELD_MARKER_FILE_NAME;
