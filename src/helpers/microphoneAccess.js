"use strict";

/**
 * The user's answer to "may PrivateTranscribe use the microphone?", enforced in
 * the main process.
 *
 * Windows never asks a desktop app for the microphone, and Electron grants
 * every getUserMedia call by default, so before this the Allow button in setup
 * only tested access that was already there. A mic test, the dictation hotkey
 * or a renderer bug could open the microphone before the user had agreed to
 * anything. Every audio capture request from any window now passes through
 * session permission handlers that answer from this module.
 *
 * The answer is saved in `microphone-access.json` in userData, so it survives
 * restarts and is read before any window loads.
 *
 * Installs from before this module have no file. Their old setup only let a
 * user past the Permissions step once a microphone request had succeeded, so a
 * finished setup (`onboardingCompleted` in the renderer's localStorage) is
 * taken as the consent it was, saved once, and never asked again. An unfinished
 * setup is never saved as a refusal: it simply stays undecided until Allow.
 */

const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");

const FILE_NAME = "microphone-access.json";
const MIGRATION_PROBE = 'localStorage.getItem("onboardingCompleted")';

class MicrophoneAccess {
  /**
   * @param {{ userDataPath?: string }} [options] userDataPath is resolved from
   *   Electron on first use when omitted, so tests can point it anywhere.
   */
  constructor({ userDataPath } = {}) {
    this._userDataPath = userDataPath || null;
    this._state = null;
    this._loaded = false;
    this._listeners = new Set();
  }

  _filePath() {
    if (!this._userDataPath) {
      const { app } = require("electron");
      this._userDataPath = app.getPath("userData");
    }
    return path.join(this._userDataPath, FILE_NAME);
  }

  _load() {
    if (this._loaded) return;
    this._loaded = true;
    try {
      const raw = fs.readFileSync(this._filePath(), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.allowed === "boolean") {
        this._state = parsed;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        debugLogger.warn("Microphone access file unreadable, treating as undecided", {
          error: error.message,
        });
      }
    }
  }

  _save(state) {
    this._state = state;
    try {
      const file = this._filePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, file);
    } catch (error) {
      // Kept in memory for this session either way; the user is asked again
      // after a restart rather than silently granted.
      debugLogger.error("Could not save the microphone decision", { error: error.message });
    }
    for (const listener of this._listeners) {
      try {
        listener(this.getState());
      } catch {
        /* a listener must never break the save */
      }
    }
  }

  /** @returns {{ allowed: boolean, decided: boolean, source: string|null }} */
  getState() {
    this._load();
    return {
      allowed: this._state?.allowed === true,
      decided: !!this._state,
      source: this._state?.source || null,
    };
  }

  isAllowed() {
    return this.getState().allowed;
  }

  /** The user pressed Allow. */
  allow(source = "user") {
    this._save({ allowed: true, source, decidedAt: new Date().toISOString() });
    debugLogger.info("Microphone allowed", { source });
    return this.getState();
  }

  onChange(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /**
   * Answer for a capture request, settling an install from before this module
   * on the way. Never throws and never saves a refusal.
   *
   * @param {Electron.WebContents | null | undefined} webContents a window of
   *   this app, whose localStorage holds the old setup state
   */
  async resolve(webContents) {
    const state = this.getState();
    if (state.decided) return state.allowed;
    if (!webContents || webContents.isDestroyed?.()) return false;
    try {
      const finished = await webContents.executeJavaScript(MIGRATION_PROBE, true);
      if (finished === "true") {
        this.allow("finished-setup-before-gate");
        return true;
      }
    } catch (error) {
      debugLogger.debug("Microphone migration probe failed", { error: error.message });
    }
    return false;
  }

  /**
   * Route the session's media permission questions through this module. Only
   * audio capture is gated; every other permission keeps Electron's default
   * answer, which is what the app ran on before.
   *
   * @param {Electron.Session} session
   */
  install(session) {
    session.setPermissionRequestHandler((webContents, permission, callback, details) => {
      if (permission !== "media" || !wantsAudio(details?.mediaTypes)) {
        callback(true);
        return;
      }
      this.resolve(webContents).then(
        (allowed) => {
          if (!allowed) {
            debugLogger.info("Microphone request refused: the user has not pressed Allow", {
              url: safeUrl(webContents),
            });
          }
          callback(allowed);
        },
        () => callback(false)
      );
    });

    session.setPermissionCheckHandler((_webContents, permission, _origin, details) => {
      if (permission !== "media") return true;
      const mediaType = details?.mediaType;
      if (mediaType && mediaType !== "audio" && mediaType !== "unknown") return true;
      return this.isAllowed();
    });
  }
}

/** An empty or missing list is treated as audio: refusing is the safe reading. */
function wantsAudio(mediaTypes) {
  if (!Array.isArray(mediaTypes) || mediaTypes.length === 0) return true;
  return mediaTypes.includes("audio");
}

function safeUrl(webContents) {
  try {
    return webContents?.getURL?.() || null;
  } catch {
    return null;
  }
}

const shared = new MicrophoneAccess();

module.exports = shared;
module.exports.MicrophoneAccess = MicrophoneAccess;
module.exports.wantsAudio = wantsAudio;
