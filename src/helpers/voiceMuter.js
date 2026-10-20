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

/** Asks the helper to let go. It reads the line once the key is down. */
function writeRelease(child) {
  try {
    child.stdin.write("release\n");
    return true;
  } catch {
    return false;
  }
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
    this._spawn = spawnHelper;
    this._resolveExecutable = resolveExecutable;
    this._heldTimeoutMs = heldTimeoutMs;
    this._releaseTimeoutMs = releaseTimeoutMs;
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
      // Same rule while the first helper is still starting.
      return this.pending.result;
    }

    const executable = this._resolveExecutable();
    if (!executable) {
      debugLogger.debug("voiceMuter: helper not found, auto-mute unavailable");
      return false;
    }

    let child;
    try {
      child = this._spawn(executable, [`--key=${key}`, `--max-ms=${maxHoldMs}`], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      debugLogger.warn("voiceMuter: failed to spawn helper", { error: error.message });
      return false;
    }
    // A write to a helper that already exited fails asynchronously on the
    // stream. Unhandled, that error would take down the main process.
    child.stdin.on("error", () => {});

    const pending = { child, key, releaseRequested: false, result: null };
    this.pending = pending;
    pending.result = this._confirmHold(pending);
    return pending.result;
  }

  async _confirmHold(pending) {
    const { child, key } = pending;
    const held = await waitForHeld(child, this._heldTimeoutMs);
    if (this.pending === pending) {
      this.pending = null;
    }

    if (!held) {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      debugLogger.warn("voiceMuter: helper did not confirm the key was held", { key });
      return false;
    }

    if (pending.releaseRequested) {
      // The dictation ended before the helper was up, as on a quick tap. The
      // release line is already waiting on its stdin, so it lets go as soon as
      // it reads it. Wait for that, then report the mute as done: the key did
      // go down, and false would warn that the call heard the dictation.
      await this._finishHelper(child);
      debugLogger.debug("voiceMuter: released mute key straight after the hold", { key });
      return true;
    }

    this.process = child;
    this.heldKey = key;
    child.on("close", () => {
      // The helper can end on its own via its max-hold timeout. Forget it so a
      // later release() does not write to a dead pipe.
      if (this.process === child) {
        this.process = null;
        this.heldKey = null;
      }
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
    if (!child) {
      return false;
    }

    this.process = null;
    const key = this.heldKey;
    this.heldKey = null;

    await this._finishHelper(child);

    debugLogger.debug("voiceMuter: released mute key", { key });
    return true;
  }

  /** Sends "release" and waits for the helper to exit. */
  _finishHelper(child) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      const timer = setTimeout(() => {
        // The helper ignored us. Kill it, which closes its stdin and makes it
        // release on the way out.
        try {
          child.kill();
        } catch {
          // Already gone.
        }
        finish();
      }, this._releaseTimeoutMs);

      if (child.exitCode !== null && child.exitCode !== undefined) {
        finish();
        return;
      }
      child.on("close", finish);

      if (!writeRelease(child)) {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
        finish();
      }
    });
  }

  /**
   * Sends the key-up half on its own, clearing a key a previous crash left
   * logically down. Safe to call for a key that is already up.
   *
   * Called at startup: a helper killed outright never runs its own release,
   * and a modifier stuck down would corrupt everything the user types.
   */
  clearStuckKey(key) {
    if (!this.isSupported || !key) {
      return false;
    }
    const executable = resolveHoldKeyExecutable();
    if (!executable) {
      return false;
    }
    try {
      const child = spawn(executable, [`--key=${key}`, "--release-only"], { windowsHide: true });
      child.on("error", () => {});
      debugLogger.debug("voiceMuter: cleared any stuck mute key", { key });
      return true;
    } catch (error) {
      debugLogger.warn("voiceMuter: failed to clear stuck key", { error: error.message });
      return false;
    }
  }
}

module.exports = new VoiceMuter();
module.exports.VoiceMuter = VoiceMuter;
module.exports.getHoldKeyExecutablePaths = getHoldKeyExecutablePaths;
module.exports.resolveHoldKeyExecutable = resolveHoldKeyExecutable;
