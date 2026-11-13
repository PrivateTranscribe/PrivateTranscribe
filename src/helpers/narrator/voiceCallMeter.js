"use strict";

/**
 * Hears whether a voice call is talking, so the narrator can wait for a pause
 * before it speaks over a friend on Discord.
 *
 * Runs windows-audio-meter.exe, which prints the loudest playback level of the
 * known voice apps 20 times a second. A pause is QUIET_MS in a row under
 * QUIET_PEAK, and it must still be going on when the words are ready. A watch
 * starts with the chime, so a pause that began during it counts from there; a
 * pause that ended while the words were made does not count at all.
 *
 * Everything fails open. No helper, no voice app playing anything, a helper
 * that dies mid-wait, or MAX_WAIT_MS without a pause all mean "speak now": a
 * line is never lost to the meter.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { VOICE_APPS } = require("../voiceApps");

const METER_EXECUTABLE = "windows-audio-meter.exe";
/**
 * Under this peak the call is quiet. Talk played at a 6% level still read
 * 0.03 to 0.06 on the meter; a call with nobody talking reads 0.
 */
const QUIET_PEAK = 0.01;
/** Long enough to be a pause in the talk, not a breath between words. */
const QUIET_MS = 700;
/** The longest the narrator waits for a pause before it speaks anyway. */
const MAX_WAIT_MS = 8000;
const POLL_MS = 50;
/** The e2e fixture's switch for everything that reads or moves the machine's audio. */
const DIAG_DISABLE_FLAG = "PRIVATETRANSCRIBE_DIAG_DISABLE_AUDIO_DUCKING";

function meterExecutablePaths({
  resourcesPath = process.resourcesPath,
  helpersDir = __dirname,
  cwd = process.cwd(),
} = {}) {
  const candidates = [];
  if (resourcesPath) candidates.push(path.join(resourcesPath, "bin", METER_EXECUTABLE));
  candidates.push(
    path.join(helpersDir, "..", "..", "..", "resources", "bin", METER_EXECUTABLE),
    path.join(cwd, "resources", "bin", METER_EXECUTABLE)
  );
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

function defaultSpawnMeter(apps) {
  if (process.platform !== "win32") return null;
  if (/^(1|true|yes)$/i.test(String(process.env[DIAG_DISABLE_FLAG] || "").trim())) return null;
  const executable = meterExecutablePaths().find((candidate) => fs.existsSync(candidate));
  if (!executable) return null;
  return spawn(executable, [`--apps=${apps.join(",")}`, `--poll=${POLL_MS}`], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
}

/**
 * Turns meter readings into whether the call leaves room to speak right now.
 * Pure, so the rule is tested without a helper: feed it {peak, sessions}
 * readings with their times.
 */
class PauseDetector {
  constructor({ quietPeak = QUIET_PEAK, quietMs = QUIET_MS } = {}) {
    this.quietPeak = quietPeak;
    this.quietMs = quietMs;
    this.quietSince = null;
  }

  /** @returns {"pause"|"no-call"|null} "pause" only while the pause lasts. */
  add({ peak, sessions }, at) {
    if (sessions === 0) {
      this.quietSince = null;
      return "no-call";
    }
    if (peak >= this.quietPeak) {
      this.quietSince = null;
      return null;
    }
    if (this.quietSince === null) this.quietSince = at;
    return at - this.quietSince >= this.quietMs ? "pause" : null;
  }
}

class VoiceCallMeter {
  constructor({
    spawnMeter = defaultSpawnMeter,
    apps = VOICE_APPS.map((app) => app.process),
    now = () => Date.now(),
    log = () => {},
  } = {}) {
    this.spawnMeter = spawnMeter;
    this.apps = apps;
    this.now = now;
    this.log = log;
  }

  /**
   * Starts reading the voice apps. The watch's waitForPause() resolves with
   * why the narrator may speak: "pause", "no-call", "no-meter", "meter-ended",
   * "cancelled" or "timeout". close() stops the helper.
   */
  watch() {
    let child = null;
    try {
      child = this.spawnMeter(this.apps);
    } catch (error) {
      this.log("Voice call meter did not start", { error: String(error?.message || error) });
    }
    const startedAt = this.now();
    const detector = new PauseDetector();
    /** What the call allows as of its last reading: "pause", "no-call" or null. */
    let room = null;
    const spawned = Boolean(child);
    let ended = !spawned;
    let wake = () => {};
    let buffer = "";

    if (child) {
      child.stdout?.setEncoding?.("utf8");
      child.stdout?.on("data", (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          let reading;
          try {
            reading = JSON.parse(line);
          } catch {
            continue;
          }
          if (typeof reading?.peak === "number" && typeof reading?.sessions === "number") {
            room = detector.add(reading, this.now());
            if (room) wake();
          }
        }
      });
      const onGone = () => {
        ended = true;
        wake();
      };
      child.on("exit", onGone);
      child.on("error", onGone);
    }

    const close = () => {
      if (!child) return;
      try {
        child.stdin?.end();
      } catch {
        // Already closed.
      }
      const exiting = child;
      child = null;
      // The helper exits when its stdin closes; this is for one that hangs.
      setTimeout(() => {
        if (exiting.exitCode === null) exiting.kill();
      }, 1000).unref?.();
    };

    const waitForPause = ({ maxMs = MAX_WAIT_MS, isAlive = () => true } = {}) =>
      new Promise((resolve) => {
        let timer = null;
        let poll = null;
        const finish = (reason) => {
          clearTimeout(timer);
          clearInterval(poll);
          wake = () => {};
          resolve({ reason, waitedMs: Math.max(0, this.now() - startedAt) });
        };
        const check = () => {
          if (!isAlive()) finish("cancelled");
          else if (room) finish(room);
          else if (ended) finish(spawned ? "meter-ended" : "no-meter");
        };
        wake = check;
        timer = setTimeout(() => finish("timeout"), Math.max(0, maxMs - (this.now() - startedAt)));
        // Cancellation has no event of its own.
        poll = setInterval(check, 250);
        check();
      });

    return { waitForPause, close };
  }
}

module.exports = {
  VoiceCallMeter,
  PauseDetector,
  meterExecutablePaths,
  QUIET_PEAK,
  QUIET_MS,
  MAX_WAIT_MS,
};
