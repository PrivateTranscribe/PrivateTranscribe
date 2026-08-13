"use strict";

/**
 * MicWatcher - tracks which voice apps are live on the microphone.
 *
 * Runs windows-mic-watch.exe, which prints a JSON line whenever the set of
 * microphone capture sessions changes, and turns that into "which known voice
 * apps are in a call right now".
 *
 * Everything here fails quiet. If the helper is missing, crashes, or prints
 * something unreadable, the answer is "no voice app detected", which makes
 * auto-mute do nothing. Dictation must never depend on this working.
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const EventEmitter = require("events");
const debugLogger = require("./debugLogger");
const { findActiveVoiceApps, parseMicWatchLine } = require("./voiceApps");

const MIC_WATCH_EXECUTABLE = "windows-mic-watch.exe";
const DEFAULT_POLL_MS = 1000;
const RESTART_DELAY_MS = 5000;
const MAX_RESTARTS = 5;

/**
 * Candidate locations for the compiled helper, in priority order: the packaged
 * resources directory first, then the two development layouts.
 */
function getMicWatchExecutablePaths({
  resourcesPath = process.resourcesPath,
  cwd = process.cwd(),
  helpersDir = __dirname,
} = {}) {
  const candidates = [];
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, "bin", MIC_WATCH_EXECUTABLE));
  }
  candidates.push(
    path.join(helpersDir, "..", "..", "resources", "bin", MIC_WATCH_EXECUTABLE),
    path.join(cwd, "resources", "bin", MIC_WATCH_EXECUTABLE)
  );
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

function resolveMicWatchExecutable(options = {}) {
  const { existsSync = fs.existsSync, ...pathOptions } = options;
  const found = getMicWatchExecutablePaths(pathOptions).find((candidate) => {
    try {
      return existsSync(candidate);
    } catch {
      return false;
    }
  });
  return found || null;
}

class MicWatcher extends EventEmitter {
  constructor() {
    super();
    this.isSupported = process.platform === "win32";
    this.process = null;
    this.buffer = "";
    this.sessions = [];
    this.activeApps = [];
    this.restartCount = 0;
    this.restartTimer = null;
    this.isStopping = false;
  }

  /**
   * True once the helper has reported at least one session list. Until then
   * "no active voice app" means "we do not know yet", so callers that care
   * about the difference should check this.
   */
  hasReading() {
    return this.sessions.length > 0 || this.activeApps.length > 0 || this.process !== null;
  }

  getActiveApps() {
    return this.activeApps;
  }

  start(pollMs = DEFAULT_POLL_MS) {
    if (!this.isSupported || this.process) {
      return false;
    }

    const executable = resolveMicWatchExecutable();
    if (!executable) {
      debugLogger.debug("micWatcher: helper not found, voice-call detection disabled");
      return false;
    }

    this.isStopping = false;

    try {
      this.process = spawn(executable, [`--poll=${pollMs}`], { windowsHide: true });
    } catch (error) {
      debugLogger.warn("micWatcher: failed to spawn helper", { error: error.message });
      this.process = null;
      return false;
    }

    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => this._consume(chunk));
    this.process.on("error", (error) => {
      debugLogger.warn("micWatcher: helper error", { error: error.message });
    });
    this.process.on("close", (code) => this._handleClose(code));

    debugLogger.debug("micWatcher: started", { executable, pollMs });
    return true;
  }

  stop() {
    this.isStopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.process) {
      try {
        this.process.kill();
      } catch {
        // Already gone.
      }
      this.process = null;
    }
    this.buffer = "";
    this._update([]);
  }

  _consume(chunk) {
    this.buffer += chunk;
    // The helper writes one JSON object per line. Keep any trailing partial
    // line for the next chunk.
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      const sessions = parseMicWatchLine(line);
      if (sessions === null) continue;
      this._update(sessions);
    }
  }

  _update(sessions) {
    const activeApps = findActiveVoiceApps(sessions);
    const changed =
      JSON.stringify(activeApps) !== JSON.stringify(this.activeApps) ||
      sessions.length !== this.sessions.length;

    this.sessions = sessions;
    this.activeApps = activeApps;

    if (changed) {
      this.emit("change", { sessions, activeApps });
    }
  }

  _handleClose(code) {
    this.process = null;

    if (this.isStopping) {
      return;
    }

    // The helper is a loop that should not exit on its own. If it does, retry a
    // bounded number of times and then give up quietly rather than respawning
    // forever against a broken audio stack.
    if (this.restartCount >= MAX_RESTARTS) {
      debugLogger.warn("micWatcher: helper keeps exiting, giving up", { code });
      this._update([]);
      return;
    }

    this.restartCount += 1;
    debugLogger.debug("micWatcher: helper exited, restarting", {
      code,
      attempt: this.restartCount,
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, RESTART_DELAY_MS);
  }
}

module.exports = new MicWatcher();
module.exports.MicWatcher = MicWatcher;
module.exports.getMicWatchExecutablePaths = getMicWatchExecutablePaths;
module.exports.resolveMicWatchExecutable = resolveMicWatchExecutable;
