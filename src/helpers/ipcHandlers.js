const { ipcMain, app, shell, dialog, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const AppUtils = require("../utils");
const debugLogger = require("./debugLogger");
const { getSystemPrompt } = require("./prompts");
const GnomeShortcutManager = require("./gnomeShortcut");
const HardwareDetector = require("./hardwareDetector");
const audioDuckingManager = require("./audioDuckingManager");
const mediaController = require("./mediaController");
const { formatTranscript } = require("./transcriptFormatter");
const {
  DEFAULT_AUTO_START_LAUNCH_MODE,
  normalizeAutoStartLaunchMode,
  buildAutoStartLaunchOptions,
  buildAutoStartSetOptions,
} = require("./autoStartLoginItemSettings");

/**
 * Allowlist of URL protocols that may be passed to shell.openExternal().
 * - https / http  : web links
 * - mailto        : email client links (e.g. support@privatetranscribe.com)
 *
 * Explicitly excluded: file://, javascript:, data:, and any unknown protocol
 * that could be exploited on the host desktop environment.
 */
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);

function isAllowedExternalUrl(url) {
  try {
    const parsed = new URL(url);
    return ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Returns true if the filename looks like a safe GGUF model file name.
 * Rejects paths that contain directory separators or traversal sequences.
 */
function isSafeModelFilename(filename) {
  if (typeof filename !== "string" || filename.length === 0) return false;
  // Allow only: word characters, hyphens, dots, and spaces - no slashes or null bytes.
  if (!/^[\w\-. ]+$/.test(filename)) return false;
  // Reject any path traversal attempt.
  if (filename.includes("..")) return false;
  return true;
}

function safeSend(sender, channel, payload) {
  if (!sender || sender.isDestroyed()) return;
  sender.send(channel, payload);
}

function postJson(urlString, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch {
      reject(new Error("Feedback endpoint is not a valid URL."));
      return;
    }

    if (!["https:", "http:"].includes(parsed.protocol)) {
      reject(new Error("Feedback endpoint must use HTTPS or HTTP."));
      return;
    }

    const body = JSON.stringify(payload);
    const client = parsed.protocol === "https:" ? https : http;
    const request = client.request(
      parsed,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...headers,
        },
        timeout: 15000,
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
            resolve({ statusCode: response.statusCode, body: responseBody });
            return;
          }
          reject(new Error(`Feedback endpoint returned ${response.statusCode || "unknown"}.`));
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("Feedback request timed out."));
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function buildFeedbackPayload(rawPayload) {
  const payload = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const message = typeof payload.message === "string" ? payload.message.trim() : "";

  if (message.length < 5) {
    throw new Error("Please write a little more feedback before sending.");
  }

  if (message.length > 5000) {
    throw new Error("Feedback is too long. Please keep it under 5000 characters.");
  }

  const analyticsManager = require("./analyticsManager");
  const allowedCategories = new Set(["bug", "confusing", "feature", "general"]);
  const category = allowedCategories.has(payload.category) ? payload.category : "general";

  return {
    message,
    category,
    contact: typeof payload.contact === "string" ? payload.contact.trim().slice(0, 300) : null,
    source: typeof payload.source === "string" ? payload.source.slice(0, 80) : "unknown",
    appVersion:
      typeof payload.appVersion === "string" && payload.appVersion.trim()
        ? payload.appVersion.trim().slice(0, 80)
        : app.getVersion(),
    deviceId: analyticsManager.getDeviceIdForExplicitFeedback(),
    submittedAt: new Date().toISOString(),
    systemInfo: {
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      isPackaged: app.isPackaged,
    },
  };
}

/**
 * Search for a filename inside `dir` up to `maxDepth` directory levels deep.
 * Returns the first matching absolute path found, or null.
 * Skips hidden directories (starting with ".") to avoid slow scans.
 *
 * @param {string} filename
 * @param {string} dir
 * @param {number} maxDepth
 * @returns {string|null}
 */
function findFileInHome(filename, dir, maxDepth) {
  if (maxDepth < 0) return null;
  const fs = require("fs");
  const path = require("path");
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // skip hidden dirs
      if (entry.isFile() && entry.name === filename) {
        return path.join(dir, entry.name);
      }
      if (entry.isDirectory() && maxDepth > 0) {
        const found = findFileInHome(filename, path.join(dir, entry.name), maxDepth - 1);
        if (found) return found;
      }
    }
  } catch {
    // Permission denied or other fs error — skip silently
  }
  return null;
}

class IPCHandlers {
  constructor(managers) {
    this.environmentManager = managers.environmentManager;
    this.databaseManager = managers.databaseManager;
    this.clipboardManager = managers.clipboardManager;
    this.whisperManager = managers.whisperManager;
    this.parakeetManager = managers.parakeetManager;
    this.windowManager = managers.windowManager;
    this.updateManager = managers.updateManager;
    this.windowsKeyManager = managers.windowsKeyManager;
    this.actionEngineManager = managers.actionEngineManager || null;
    this.benchmarkManager = managers.benchmarkManager || null;
    this.getCudaAutoUpdateState = managers.getCudaAutoUpdateState || null;
    this.clearCudaAutoUpdateFailure = managers.clearCudaAutoUpdateFailure || null;
    this.hardwareDetector = new HardwareDetector();
    // Current history limit - synced from control panel via set-history-limit.
    // Default 50 until the renderer sends the real value.
    this.historyLimit = 50;
    this.setupHandlers();
  }

  _getDictionarySafe() {
    try {
      return this.databaseManager.getDictionary();
    } catch {
      return [];
    }
  }

  _syncStartupEnv(setVars, clearVars = []) {
    let changed = false;
    for (const [key, value] of Object.entries(setVars)) {
      if (process.env[key] !== value) {
        process.env[key] = value;
        changed = true;
      }
    }
    for (const key of clearVars) {
      if (process.env[key]) {
        delete process.env[key];
        changed = true;
      }
    }
    if (changed) {
      debugLogger.debug("Synced startup env vars", {
        set: Object.keys(setVars),
        cleared: clearVars.filter((k) => !process.env[k]),
      });
      this.environmentManager.saveAllKeysToEnvFile();
    }
  }

  _getAutoStartPreferencesPath() {
    return path.join(app.getPath("userData"), "auto-start-preferences.json");
  }

  _readAutoStartLaunchMode() {
    try {
      const raw = fs.readFileSync(this._getAutoStartPreferencesPath(), "utf8");
      const parsed = JSON.parse(raw);
      return normalizeAutoStartLaunchMode(parsed?.launchMode);
    } catch {
      return DEFAULT_AUTO_START_LAUNCH_MODE;
    }
  }

  _writeAutoStartLaunchMode(launchMode) {
    const normalized = normalizeAutoStartLaunchMode(launchMode);
    fs.writeFileSync(
      this._getAutoStartPreferencesPath(),
      JSON.stringify({ launchMode: normalized }, null, 2),
      "utf8"
    );
    return normalized;
  }

  _buildAutoStartSetOptions(enabled, launchMode = this._readAutoStartLaunchMode()) {
    return buildAutoStartSetOptions({
      enabled,
      platform: process.platform,
      isPackaged: app.isPackaged,
      execPath: process.execPath,
      appPath: app.getAppPath(),
      launchMode,
    });
  }

  _buildAutoStartLaunchOptions(launchMode = this._readAutoStartLaunchMode()) {
    return buildAutoStartLaunchOptions({
      platform: process.platform,
      isPackaged: app.isPackaged,
      execPath: process.execPath,
      appPath: app.getAppPath(),
      launchMode,
    });
  }

  _getAutoStartEnabled(launchMode = this._readAutoStartLaunchMode()) {
    const loginSettings = app.getLoginItemSettings(this._buildAutoStartLaunchOptions(launchMode));
    if (loginSettings.openAtLogin || process.platform !== "win32") {
      return loginSettings.openAtLogin;
    }

    // Older installs registered the app without the explicit startup-mode args.
    // Preserve their enabled state when the user changes launch mode.
    return app.getLoginItemSettings().openAtLogin;
  }

  setupHandlers() {
    // Window control handlers
    ipcMain.handle("window-minimize", () => {
      if (this.windowManager.controlPanelWindow) {
        this.windowManager.controlPanelWindow.minimize();
      }
    });

    ipcMain.handle("window-maximize", () => {
      if (this.windowManager.controlPanelWindow) {
        if (this.windowManager.controlPanelWindow.isMaximized()) {
          this.windowManager.controlPanelWindow.unmaximize();
        } else {
          this.windowManager.controlPanelWindow.maximize();
        }
      }
    });

    ipcMain.handle("window-close", () => {
      if (this.windowManager.controlPanelWindow) {
        this.windowManager.controlPanelWindow.close();
      }
    });

    ipcMain.handle("window-is-maximized", () => {
      if (this.windowManager.controlPanelWindow) {
        return this.windowManager.controlPanelWindow.isMaximized();
      }
      return false;
    });

    ipcMain.handle("app-quit", () => {
      app.quit();
    });

    ipcMain.handle("hide-window", () => {
      if (process.platform === "darwin") {
        this.windowManager.hideDictationPanel();
        if (app.dock) app.dock.show();
      } else {
        this.windowManager.hideDictationPanel();
      }
    });

    ipcMain.handle("show-dictation-panel", async () => {
      await this.windowManager.showDictationPanel();
    });

    ipcMain.handle("set-overlay-disabled", (_event, disabled) => {
      this.windowManager.setOverlayDisabled(Boolean(disabled));
      return { success: true, disabled: Boolean(disabled) };
    });

    ipcMain.handle("get-overlay-disabled", () => {
      return { disabled: this.windowManager.isOverlayDisabled() };
    });

    ipcMain.handle("set-overlay-snap-to-taskbar", (_event, enabled) => {
      this.windowManager.setOverlaySnapToTaskbar(Boolean(enabled));
      return { success: true, enabled: this.windowManager.isOverlaySnapToTaskbarEnabled() };
    });

    ipcMain.handle("get-overlay-snap-to-taskbar", () => {
      return { enabled: this.windowManager.isOverlaySnapToTaskbarEnabled() };
    });

    ipcMain.handle("notify-dictation-completed", () => {
      // When overlay is disabled, destroy the hidden window after dictation
      // to eliminate DWM lag while gaming.
      if (this.windowManager.isOverlayDisabled()) {
        this.windowManager.hideDictationPanel();
      }
      return { success: true };
    });

    ipcMain.handle("dictation-overlay-ready", (event) => {
      if (event.sender === this.windowManager.mainWindow?.webContents) {
        this.windowManager.markMainWindowRendererReady();
      }
      return { success: true };
    });

    ipcMain.handle("open-control-panel", async () => {
      await this.windowManager.createControlPanelWindow();
      return { success: true };
    });

    ipcMain.handle("set-main-window-interactivity", (event, shouldCapture) => {
      this.windowManager.setMainWindowInteractivity(Boolean(shouldCapture));
      return { success: true };
    });

    ipcMain.handle("refresh-main-window-interactivity", () => {
      this.windowManager.refreshMainWindowInteractivity("renderer");
      return { success: true };
    });

    ipcMain.handle("resize-main-window", (_event, _sizeKey) => {
      // No-op: window now uses a fixed transparent container; see windowManager.resizeMainWindow.
      return { success: true };
    });

    // Environment handlers
    ipcMain.handle("get-openai-key", async (event) => {
      return this.environmentManager.getOpenAIKey();
    });

    ipcMain.handle("save-openai-key", async (event, key) => {
      return this.environmentManager.saveOpenAIKey(key);
    });

    ipcMain.handle("create-production-env-file", async (event, apiKey) => {
      return this.environmentManager.createProductionEnvFile(apiKey);
    });

    ipcMain.handle("set-history-limit", async (event, limit) => {
      const parsed = parseInt(limit, 10);
      // Clamp to [0, 100 000]: 0 = disabled (no history), upper bound prevents runaway values.
      this.historyLimit = isNaN(parsed) || parsed < 0 ? 50 : Math.min(parsed, 100_000);
      return { success: true };
    });

    ipcMain.handle("db-save-transcription", async (event, text, durationSeconds, options = {}) => {
      // If historyLimit is 0, the user has opted out of history - don't write to DB
      if (this.historyLimit === 0) {
        return { success: true, skipped: true };
      }
      try {
        const result = this.databaseManager.saveTranscription(text, durationSeconds, options);
        if (result?.success && result?.transcription) {
          // Enforce the retention limit immediately after each save.
          // trimTranscriptions is a no-op if count <= limit, so this is always safe.
          try {
            this.databaseManager.trimTranscriptions(this.historyLimit);
          } catch (trimErr) {
            // Non-fatal - the save itself succeeded; log and continue.
            debugLogger.error("Failed to trim transcriptions after save:", trimErr);
          }
          setImmediate(() => {
            this.broadcastToWindows("transcription-added", result.transcription);
          });
        }
        return result;
      } catch (err) {
        debugLogger.error("[IPC:db-save-transcription] error:", err.message);
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle("db-get-transcriptions", async (event, limit = 50) => {
      const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 50, 10_000));
      try {
        return this.databaseManager.getTranscriptions(safeLimit);
      } catch (err) {
        debugLogger.error("[IPC:db-get-transcriptions] error:", err.message);
        return { success: true, data: [] };
      }
    });

    ipcMain.handle("db-clear-transcriptions", async (event) => {
      try {
        const result = this.databaseManager.clearTranscriptions();
        if (result?.success) {
          setImmediate(() => {
            this.broadcastToWindows("transcriptions-cleared", {
              cleared: result.cleared,
            });
          });
        }
        return result;
      } catch (err) {
        debugLogger.error("[IPC:db-clear-transcriptions] error:", err.message);
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle("db-delete-transcription", async (event, id) => {
      try {
        const result = this.databaseManager.deleteTranscription(id);
        if (result?.success) {
          setImmediate(() => {
            this.broadcastToWindows("transcription-deleted", { id });
          });
        }
        return result;
      } catch (err) {
        debugLogger.error("[IPC:db-delete-transcription] error:", err.message);
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle("db-trim-transcriptions", async (event, limit) => {
      const safeLimit = Math.max(0, Math.min(parseInt(limit, 10) || 0, 100_000));
      try {
        const result = this.databaseManager.trimTranscriptions(safeLimit);
        if (result?.success) {
          setImmediate(() => {
            this.broadcastToWindows("transcriptions-cleared", {
              cleared: result.trimmed ?? result.cleared ?? 0,
            });
          });
        }
        return result;
      } catch (err) {
        debugLogger.error("[IPC:db-trim-transcriptions] error:", err.message);
        return { success: false, error: err.message };
      }
    });

    // Dictionary handlers
    ipcMain.handle("db-get-dictionary", async () => {
      try {
        return this.databaseManager.getDictionary();
      } catch (err) {
        debugLogger.error("[IPC:db-get-dictionary] error:", err.message);
        return { success: true, data: [] };
      }
    });

    ipcMain.handle("db-set-dictionary", async (event, words) => {
      try {
        if (!Array.isArray(words)) {
          throw new Error("words must be an array");
        }
        if (words.length > 10_000) {
          throw new Error("Dictionary too large: maximum 10,000 entries allowed");
        }
        // Coerce all entries to trimmed strings and drop empties.
        // This prevents non-string values from reaching the database layer.
        const sanitized = words
          .filter((w) => typeof w === "string")
          .map((w) => w.trim().substring(0, 200))
          .filter(Boolean);
        return this.databaseManager.setDictionary(sanitized);
      } catch (err) {
        debugLogger.error("[IPC:db-set-dictionary] error:", err.message);
        return { success: false, error: err.message };
      }
    });

    // Correction memory (local, privacy-first)
    ipcMain.handle("db-get-correction-memory", async (event, limit = 500) => {
      try {
        return this.databaseManager.getCorrectionMemory(limit);
      } catch (err) {
        debugLogger.error("[IPC:db-get-correction-memory] error:", err.message);
        return [];
      }
    });

    ipcMain.handle("db-upsert-correction", async (event, source, target) => {
      try {
        return this.databaseManager.upsertCorrection(source, target);
      } catch (err) {
        debugLogger.error("[IPC:db-upsert-correction] error:", err.message);
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle("db-confirm-correction", async (event, source, target) => {
      try {
        return this.databaseManager.confirmCorrection(source, target);
      } catch (err) {
        debugLogger.error("[IPC:db-confirm-correction] error:", err.message);
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle("db-delete-correction", async (event, source) => {
      try {
        return this.databaseManager.deleteCorrection(source);
      } catch (err) {
        debugLogger.error("[IPC:db-delete-correction] error:", err.message);
        return { success: false, error: err.message };
      }
    });

    // Stats handlers
    ipcMain.handle("db-get-stats", async () => {
      try {
        return this.databaseManager.getStats();
      } catch (err) {
        debugLogger.error("[IPC:db-get-stats] error:", err.message);
        return null;
      }
    });

    ipcMain.handle("db-get-streak-dates", async () => {
      try {
        return this.databaseManager.getStreakDates();
      } catch (err) {
        debugLogger.error("[IPC:db-get-streak-dates] error:", err.message);
        return [];
      }
    });

    ipcMain.handle("db-reset-stats", async (event) => {
      try {
        const result = this.databaseManager.resetStats();
        if (result?.success) {
          const refreshed = this.databaseManager.getTranscriptions();
          event.sender.send("transcriptions-reloaded", refreshed);
        }
        return result;
      } catch (err) {
        debugLogger.error("[IPC:db-reset-stats] error:", err.message);
        return { success: false, error: err.message };
      }
    });

    // Clipboard handlers
    ipcMain.handle("paste-text", async (event, text) => {
      return this.clipboardManager.pasteText(text);
    });

    ipcMain.handle("read-clipboard", async (event) => {
      return this.clipboardManager.readClipboard();
    });

    ipcMain.handle("write-clipboard", async (event, text) => {
      return this.clipboardManager.writeClipboard(text);
    });

    ipcMain.handle("show-notification", async (event, title, body) => {
      const { Notification } = require("electron");
      if (Notification.isSupported()) {
        new Notification({ title: title || "PrivateTranscribe", body: body || "" }).show();
      }
    });

    ipcMain.handle("check-paste-tools", async () => {
      return this.clipboardManager.checkPasteTools();
    });

    // Active app/window context (privacy-first, best-effort)
    ipcMain.handle("get-active-window-context", async () => {
      const { getActiveWindowContext } = require("./activeWindowContext");
      return getActiveWindowContext();
    });

    // File identifier extraction for Smart Context (opt-in, local only)
    ipcMain.handle("extract-file-identifiers", async (_, filename) => {
      if (!filename || typeof filename !== "string") {
        return { blocked: true, reason: "invalid filename", identifiers: [] };
      }
      // Reject path traversal attempts before any filesystem work
      if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
        return { blocked: true, reason: "invalid filename", identifiers: [] };
      }
      const os = require("os");
      const homeDir = os.homedir();
      const { extractFromFilePath } = require("./fileIdentifierExtractor");
      const found = findFileInHome(filename, homeDir, 3);
      if (!found) {
        return { blocked: false, identifiers: [], reason: "file not found in home dir" };
      }
      return extractFromFilePath(found, homeDir);
    });

    // File content extraction for LLM Context Enhancement (opt-in, local only)
    ipcMain.handle("extract-file-context", async (_, filename, options = {}) => {
      if (!filename || typeof filename !== "string") {
        return { blocked: true, reason: "invalid filename" };
      }
      if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
        return { blocked: true, reason: "invalid filename" };
      }
      const os = require("os");
      const homeDir = os.homedir();
      const { extractFileContext } = require("./fileContextExtractor");
      const found = findFileInHome(filename, homeDir, 3);
      if (!found) {
        return { blocked: false, reason: "file not found in home dir" };
      }
      return extractFileContext(found, homeDir, undefined, options);
    });

    // Whisper handlers
    ipcMain.handle("transcribe-local-whisper", async (event, audioBlob, options = {}) => {
      debugLogger.log("transcribe-local-whisper called", {
        audioBlobType: typeof audioBlob,
        audioBlobSize: audioBlob?.byteLength || audioBlob?.length || 0,
        options,
      });

      try {
        const result = await this.whisperManager.transcribeLocalWhisper(audioBlob, options);

        debugLogger.log("Whisper result", {
          success: result.success,
          hasText: !!result.text,
          message: result.message,
          error: result.error,
        });

        // Check if no audio was detected and send appropriate event
        if (!result.success && result.message === "No audio detected") {
          debugLogger.log("Sending no-audio-detected event to renderer");
          event.sender.send("no-audio-detected");
        }

        return result;
      } catch (error) {
        debugLogger.error("Local Whisper transcription error", error);
        const errorMessage = error.message || "Unknown error";

        // Return specific error types for better user feedback
        if (errorMessage.includes("FFmpeg not found")) {
          return {
            success: false,
            error: "ffmpeg_not_found",
            message: "FFmpeg is missing. Please reinstall the app or install FFmpeg manually.",
          };
        }
        if (
          errorMessage.includes("FFmpeg conversion failed") ||
          errorMessage.includes("FFmpeg process error")
        ) {
          return {
            success: false,
            error: "ffmpeg_error",
            message: "Audio conversion failed. The recording may be corrupted.",
          };
        }
        if (
          errorMessage.includes("whisper.cpp not found") ||
          errorMessage.includes("whisper-cpp")
        ) {
          return {
            success: false,
            error: "whisper_not_found",
            message: "Whisper binary is missing. Please reinstall the app.",
          };
        }
        if (
          errorMessage.includes("Audio buffer is empty") ||
          errorMessage.includes("Audio data too small")
        ) {
          return {
            success: false,
            error: "no_audio_data",
            message: "No audio detected",
          };
        }
        if (errorMessage.includes("model") && errorMessage.includes("not downloaded")) {
          return {
            success: false,
            error: "model_not_found",
            message: errorMessage,
          };
        }

        throw error;
      }
    });

    ipcMain.handle("transcribe-file-v2", async (event, audioBlob, options = {}) => {
      debugLogger.log("transcribe-file-v2 called", {
        audioBlobType: typeof audioBlob,
        audioBlobSize: audioBlob?.byteLength || audioBlob?.length || 0,
        options,
      });

      try {
        const onProgress = (progress) => {
          try {
            event.sender.send("file-transcription-progress", progress);
          } catch {
            // Window may have been closed
          }
        };

        const result = await this.whisperManager.transcribeFileV2(audioBlob, {
          ...options,
          fileMode: true,
          onProgress,
        });
        if (!result.success) return result;

        const speakerDetectionMode =
          result.speakerDetectionMode ||
          options.speakerDetectionMode ||
          (options.speakerDetection === true ? "tiny-diarize-en" : "off");
        const formatted = formatTranscript(
          result.raw || { text: result.text, segments: result.segments },
          options.outputFormat || "plain",
          {
            includeSpeakers: options.speakerDetection === true || speakerDetectionMode !== "off",
          }
        );

        return {
          success: true,
          text: formatted.text || result.text,
          srt: formatted.srt,
          speakerCount: formatted.speakerCount,
          speakers: formatted.speakers,
          segments: formatted.segments,
          format: options.outputFormat || "plain",
          model: result.model,
          speakerDetectionActive: result.speakerDetectionActive,
          speakerDetectionMode,
          diarizationEngine: result.diarizationEngine,
          diarization: result.diarization,
        };
      } catch (error) {
        debugLogger.error("File transcription v2 error", error);
        return { success: false, error: error.message || "File transcription failed" };
      }
    });

    ipcMain.handle("check-diarization-model-status", async () => {
      try {
        return { success: true, ...this.whisperManager.getDiarizationModelStatus() };
      } catch (error) {
        return { success: false, ready: false, error: error.message };
      }
    });

    ipcMain.handle("download-diarization-models", async (event) => {
      try {
        return await this.whisperManager.downloadDiarizationModels((progress) => {
          event.sender.send("diarization-download-progress", progress);
        });
      } catch (error) {
        event.sender.send("diarization-download-progress", {
          type: "error",
          model: "sherpa-onnx-multilingual-v1",
          error: error.message,
        });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("check-whisper-installation", async (event) => {
      return this.whisperManager.checkWhisperInstallation();
    });

    ipcMain.handle("get-audio-diagnostics", async () => {
      return this.whisperManager.getDiagnostics();
    });

    ipcMain.handle("download-whisper-model", async (event, modelName) => {
      return this.whisperManager.downloadWhisperModel(modelName, (progressData) => {
        safeSend(event.sender, "whisper-download-progress", progressData);
      });
    });

    ipcMain.handle("check-model-status", async (event, modelName) => {
      return this.whisperManager.checkModelStatus(modelName);
    });

    ipcMain.handle("list-whisper-models", async (event) => {
      return this.whisperManager.listWhisperModels();
    });

    ipcMain.handle("delete-whisper-model", async (event, modelName) => {
      return this.whisperManager.deleteWhisperModel(modelName);
    });

    ipcMain.handle("delete-all-whisper-models", async () => {
      return this.whisperManager.deleteAllWhisperModels();
    });

    ipcMain.handle("cancel-whisper-download", async (event) => {
      return this.whisperManager.cancelDownload();
    });

    // Whisper server handlers (for faster repeated transcriptions)
    ipcMain.handle("whisper-server-start", async (event, modelName) => {
      return this.whisperManager.startServer(modelName);
    });

    ipcMain.handle("whisper-server-stop", async () => {
      return this.whisperManager.stopServer();
    });

    ipcMain.handle("get-cuda-binary-status", async () => {
      const cudaStatus = this.whisperManager.getCudaBinaryStatus();
      const autoUpdateState = this.getCudaAutoUpdateState ? this.getCudaAutoUpdateState() : null;
      return {
        ...cudaStatus,
        cudaAutoUpdateFailed: !!autoUpdateState?.failed,
      };
    });

    ipcMain.handle("download-cuda-binary", async (event) => {
      try {
        const result = await this.whisperManager.downloadGpuBinary((progress) => {
          safeSend(event.sender, "cuda-binary-download-progress", progress);
        });
        if (result?.success) {
          await this.whisperManager.invalidateServerCache({ stopRunningServer: true });
          if (this.clearCudaAutoUpdateFailure) {
            this.clearCudaAutoUpdateFailure();
          }
        }
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("cancel-cuda-binary-download", async () => {
      this.whisperManager.cancelGpuBinaryDownload();
      return { success: true };
    });

    ipcMain.handle("set-whisper-force-cpu", async (_event, value) => {
      try {
        if (this.whisperManager.isProcessing && this.whisperManager.isProcessing()) {
          return {
            success: false,
            error: "Cannot change engine while transcription is in progress",
          };
        }
        await this.whisperManager.setForceCpu(!!value);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("whisper-server-status", async () => {
      return this.whisperManager.getEngineStatus?.() || this.whisperManager.getServerStatus();
    });

    ipcMain.handle("whisper-server-set-idle-timeout-minutes", async (_event, minutes) => {
      try {
        return this.whisperManager.setServerIdleTimeoutMinutes(minutes);
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("parakeet-server-set-idle-timeout-minutes", async (_event, minutes) => {
      try {
        if (!this.parakeetManager)
          return { success: false, error: "Parakeet manager not available" };
        return this.parakeetManager.setServerIdleTimeoutMinutes(minutes);
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("llama-server-set-idle-timeout-minutes", async (_event, minutes) => {
      try {
        const modelManager = require("../helpers/modelManagerBridge").default;
        return modelManager.setServerIdleTimeoutMinutes(minutes);
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("check-ffmpeg-availability", async (event) => {
      return this.whisperManager.checkFFmpegAvailability();
    });

    // Parakeet (NVIDIA) handlers
    ipcMain.handle("transcribe-local-parakeet", async (event, audioBlob, options = {}) => {
      debugLogger.log("transcribe-local-parakeet called", {
        audioBlobType: typeof audioBlob,
        audioBlobSize: audioBlob?.byteLength || audioBlob?.length || 0,
        options,
      });

      try {
        const result = await this.parakeetManager.transcribeLocalParakeet(audioBlob, options);

        debugLogger.log("Parakeet result", {
          success: result.success,
          hasText: !!result.text,
          message: result.message,
          error: result.error,
        });

        if (!result.success && result.message === "No audio detected") {
          debugLogger.log("Sending no-audio-detected event to renderer");
          event.sender.send("no-audio-detected");
        }

        return result;
      } catch (error) {
        debugLogger.error("Local Parakeet transcription error", error);
        const errorMessage = error.message || "Unknown error";

        if (errorMessage.includes("sherpa-onnx") && errorMessage.includes("not found")) {
          return {
            success: false,
            error: "parakeet_not_found",
            message: "Parakeet binary is missing. Please reinstall the app.",
          };
        }
        if (errorMessage.includes("model") && errorMessage.includes("not downloaded")) {
          return {
            success: false,
            error: "model_not_found",
            message: errorMessage,
          };
        }

        throw error;
      }
    });

    ipcMain.handle("check-parakeet-installation", async () => {
      return this.parakeetManager.checkInstallation();
    });

    ipcMain.handle("download-parakeet-model", async (event, modelName) => {
      return this.parakeetManager.downloadParakeetModel(modelName, (progressData) => {
        safeSend(event.sender, "parakeet-download-progress", progressData);
      });
    });

    ipcMain.handle("check-parakeet-model-status", async (_event, modelName) => {
      return this.parakeetManager.checkModelStatus(modelName);
    });

    ipcMain.handle("list-parakeet-models", async () => {
      return this.parakeetManager.listParakeetModels();
    });

    ipcMain.handle("delete-parakeet-model", async (_event, modelName) => {
      return this.parakeetManager.deleteParakeetModel(modelName);
    });

    ipcMain.handle("delete-all-parakeet-models", async () => {
      return this.parakeetManager.deleteAllParakeetModels();
    });

    ipcMain.handle("cancel-parakeet-download", async () => {
      return this.parakeetManager.cancelDownload();
    });

    ipcMain.handle("get-parakeet-diagnostics", async () => {
      return this.parakeetManager.getDiagnostics();
    });

    // Parakeet server handlers (for faster repeated transcriptions)
    ipcMain.handle("parakeet-server-start", async (event, modelName) => {
      const result = await this.parakeetManager.startServer(modelName);
      process.env.LOCAL_TRANSCRIPTION_PROVIDER = "nvidia";
      process.env.PARAKEET_MODEL = modelName;
      this.environmentManager.saveAllKeysToEnvFile();
      return result;
    });

    ipcMain.handle("parakeet-server-stop", async () => {
      const result = await this.parakeetManager.stopServer();
      delete process.env.LOCAL_TRANSCRIPTION_PROVIDER;
      delete process.env.PARAKEET_MODEL;
      this.environmentManager.saveAllKeysToEnvFile();
      return result;
    });

    ipcMain.handle("parakeet-server-status", async () => {
      return this.parakeetManager.getServerStatus();
    });

    // Utility handlers
    ipcMain.handle("cleanup-app", async (event) => {
      try {
        AppUtils.cleanup(this.windowManager.mainWindow);
        require("electron").app.relaunch();
        require("electron").app.exit(0);
        return { success: true, message: "Cleanup completed successfully" };
      } catch (error) {
        throw error;
      }
    });

    ipcMain.handle("update-hotkey", async (event, hotkey) => {
      return await this.windowManager.updateHotkey(hotkey);
    });

    ipcMain.handle("set-hotkey-listening-mode", async (event, enabled, newHotkey = null) => {
      this.windowManager.setHotkeyListeningMode(enabled);
      const hotkeyManager = this.windowManager.hotkeyManager;

      // When exiting capture mode with a new hotkey, use that to avoid reading stale state
      const effectiveHotkey = !enabled && newHotkey ? newHotkey : hotkeyManager.getCurrentHotkey();

      if (enabled) {
        // Entering capture mode - unregister globalShortcut so it doesn't consume key events
        // Note: mouse side-buttons (Mouse4/Mouse5) are not valid Electron accelerators.
        const currentHotkey = hotkeyManager.getCurrentHotkey();
        if (
          currentHotkey &&
          currentHotkey !== "GLOBE" &&
          !hotkeyManager.isNativeListenerHotkey(currentHotkey)
        ) {
          debugLogger.log(
            `[IPC] Unregistering globalShortcut "${currentHotkey}" for hotkey capture mode`
          );
          const { globalShortcut } = require("electron");
          globalShortcut.unregister(currentHotkey);
        }

        // On Windows, stop the Windows key listener
        if (process.platform === "win32" && this.windowsKeyManager) {
          debugLogger.log("[IPC] Stopping Windows key listener for hotkey capture mode");
          this.windowsKeyManager.stop();
        }

        // On GNOME Wayland, unregister the keybinding during capture
        if (hotkeyManager.isUsingGnome() && hotkeyManager.gnomeManager) {
          debugLogger.log("[IPC] Unregistering GNOME keybinding for hotkey capture mode");
          await hotkeyManager.gnomeManager.unregisterKeybinding().catch((err) => {
            debugLogger.warn("[IPC] Failed to unregister GNOME keybinding:", err.message);
          });
        }
      } else {
        // Exiting capture mode - re-register globalShortcut if not already registered
        // (Skip native-listener hotkeys: mouse buttons and modifier-only combos like Control+Super)
        if (
          effectiveHotkey &&
          effectiveHotkey !== "GLOBE" &&
          !hotkeyManager.isNativeListenerHotkey(effectiveHotkey)
        ) {
          const { globalShortcut } = require("electron");
          if (!globalShortcut.isRegistered(effectiveHotkey)) {
            debugLogger.log(
              `[IPC] Re-registering globalShortcut "${effectiveHotkey}" after capture mode`
            );
            const callback = this.windowManager.createHotkeyCallback();
            globalShortcut.register(effectiveHotkey, callback);
          }
        }

        // On Windows, restart the native listener if the hotkey needs it
        if (process.platform === "win32" && this.windowsKeyManager) {
          const activationMode = await this.windowManager.getActivationMode();
          debugLogger.log(
            `[IPC] Exiting hotkey capture mode, activationMode="${activationMode}", hotkey="${effectiveHotkey}"`
          );
          if (
            effectiveHotkey &&
            effectiveHotkey !== "GLOBE" &&
            hotkeyManager.isNativeListenerHotkey(effectiveHotkey)
          ) {
            debugLogger.log(`[IPC] Restarting Windows key listener for hotkey: ${effectiveHotkey}`);
            this.windowsKeyManager.start(effectiveHotkey);
          } else if (activationMode !== "tap" && effectiveHotkey && effectiveHotkey !== "GLOBE") {
            this.windowsKeyManager.start(effectiveHotkey);
          }
        }

        // On GNOME Wayland, re-register the keybinding with the effective hotkey
        if (hotkeyManager.isUsingGnome() && hotkeyManager.gnomeManager && effectiveHotkey) {
          const gnomeHotkey = GnomeShortcutManager.convertToGnomeFormat(effectiveHotkey);
          debugLogger.log(
            `[IPC] Re-registering GNOME keybinding "${gnomeHotkey}" after capture mode`
          );
          const success = await hotkeyManager.gnomeManager.registerKeybinding(gnomeHotkey);
          if (success) {
            hotkeyManager.currentHotkey = effectiveHotkey;
          }
        }
      }

      return { success: true };
    });

    ipcMain.handle("get-hotkey-mode-info", async () => {
      return {
        isUsingGnome: this.windowManager.isUsingGnomeHotkeys(),
      };
    });

    ipcMain.handle("start-window-drag", async (event) => {
      return await this.windowManager.startWindowDrag();
    });

    ipcMain.handle("stop-window-drag", async (event) => {
      return await this.windowManager.stopWindowDrag();
    });

    // External link handler - only safe external URL protocols are permitted.
    ipcMain.handle("open-external", async (event, url) => {
      if (!isAllowedExternalUrl(url)) {
        debugLogger.warn("open-external blocked unsafe URL", { url });
        return {
          success: false,
          error: "Only http, https, and mailto URLs may be opened externally.",
        };
      }
      try {
        await shell.openExternal(url);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("submit-feedback", async (_event, payload) => {
      try {
        const analyticsManager = require("./analyticsManager");
        const { url: supabaseUrl, anonKey } = analyticsManager.getSupabaseConfig();
        const endpoint =
          process.env.PRIVATE_TRANSCRIBE_FEEDBACK_ENDPOINT ||
          `${supabaseUrl}/functions/v1/feedback`;

        if (!anonKey) {
          return {
            success: false,
            error:
              "Feedback service is missing the Supabase publishable key. Please copy support@privatetranscribe.com instead.",
            code: "FEEDBACK_SUPABASE_KEY_MISSING",
          };
        }

        const feedbackPayload = buildFeedbackPayload(payload);
        const headers = {
          apikey: anonKey,
          authorization: `Bearer ${anonKey}`,
        };

        await postJson(endpoint, feedbackPayload, headers);
        debugLogger.info("Feedback submitted", {
          category: feedbackPayload.category,
          source: feedbackPayload.source,
          includeSystemInfo: Boolean(feedbackPayload.systemInfo),
        });
        return { success: true };
      } catch (error) {
        debugLogger.warn("Feedback submission failed", { error: error.message });
        return { success: false, error: error.message || "Feedback could not be sent." };
      }
    });

    // Auto-start handlers
    ipcMain.handle("get-auto-start-enabled", async () => {
      try {
        return this._getAutoStartEnabled();
      } catch (error) {
        debugLogger.error("Error getting auto-start status:", error);
        return false;
      }
    });

    ipcMain.handle("set-auto-start-enabled", async (event, enabled) => {
      try {
        const launchMode = this._readAutoStartLaunchMode();
        app.setLoginItemSettings(this._buildAutoStartSetOptions(enabled, launchMode));
        debugLogger.debug("Auto-start setting updated", { enabled, launchMode });
        return { success: true };
      } catch (error) {
        debugLogger.error("Error setting auto-start:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-auto-start-launch-mode", async () => {
      return this._readAutoStartLaunchMode();
    });

    ipcMain.handle("set-auto-start-launch-mode", async (event, mode) => {
      try {
        const previousLaunchMode = this._readAutoStartLaunchMode();
        const wasEnabled = this._getAutoStartEnabled(previousLaunchMode);
        const launchMode = this._writeAutoStartLaunchMode(mode);
        app.setLoginItemSettings(this._buildAutoStartSetOptions(wasEnabled, launchMode));
        debugLogger.debug("Auto-start launch mode updated", {
          launchMode,
          enabled: wasEnabled,
        });
        return { success: true, launchMode };
      } catch (error) {
        debugLogger.error("Error setting auto-start launch mode:", error);
        return { success: false, error: error.message };
      }
    });

    // Model management handlers
    ipcMain.handle("model-get-all", async () => {
      try {
        debugLogger.debug("model-get-all called", undefined, "ipc");
        const modelManager = require("./modelManagerBridge").default;
        const models = await modelManager.getModelsWithStatus();
        debugLogger.debug("Returning models", { count: models.length }, "ipc");
        return models;
      } catch (error) {
        debugLogger.error("Error in model-get-all:", error);
        throw error;
      }
    });

    ipcMain.handle("model-check", async (_, modelId) => {
      const modelManager = require("./modelManagerBridge").default;
      return modelManager.isModelDownloaded(modelId);
    });

    ipcMain.handle("model-download", async (event, modelId) => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        const result = await modelManager.downloadModel(
          modelId,
          (progress, downloadedSize, totalSize) => {
            safeSend(event.sender, "model-download-progress", {
              modelId,
              progress,
              downloadedSize,
              totalSize,
            });
          }
        );
        return { success: true, path: result };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          code: error.code,
          details: error.details,
        };
      }
    });

    ipcMain.handle("model-delete", async (event, modelId) => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        const { freed_mb } = await modelManager.deleteModel(modelId);
        return { success: true, freed_mb };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          code: error.code,
          details: error.details,
        };
      }
    });

    ipcMain.handle("model-delete-all", async () => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        await modelManager.deleteAllModels();
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          code: error.code,
          details: error.details,
        };
      }
    });

    ipcMain.handle("model-cancel-download", async (event, modelId) => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        const cancelled = modelManager.cancelDownload(modelId);
        return { success: cancelled };
      } catch (error) {
        return {
          success: false,
          error: error.message,
        };
      }
    });

    ipcMain.handle("model-check-runtime", async (event) => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        await modelManager.ensureLlamaCpp();
        return { available: true };
      } catch (error) {
        return {
          available: false,
          error: error.message,
          code: error.code,
          details: error.details,
        };
      }
    });

    ipcMain.handle("get-anthropic-key", async (event) => {
      return this.environmentManager.getAnthropicKey();
    });

    ipcMain.handle("get-gemini-key", async (event) => {
      return this.environmentManager.getGeminiKey();
    });

    ipcMain.handle("save-gemini-key", async (event, key) => {
      return this.environmentManager.saveGeminiKey(key);
    });

    ipcMain.handle("get-groq-key", async (event) => {
      return this.environmentManager.getGroqKey();
    });

    ipcMain.handle("save-groq-key", async (event, key) => {
      return this.environmentManager.saveGroqKey(key);
    });

    ipcMain.handle("get-custom-transcription-key", async () => {
      return this.environmentManager.getCustomTranscriptionKey();
    });

    ipcMain.handle("save-custom-transcription-key", async (event, key) => {
      return this.environmentManager.saveCustomTranscriptionKey(key);
    });

    ipcMain.handle("get-custom-reasoning-key", async () => {
      return this.environmentManager.getCustomReasoningKey();
    });

    ipcMain.handle("save-custom-reasoning-key", async (event, key) => {
      return this.environmentManager.saveCustomReasoningKey(key);
    });

    // Dictation key handlers for reliable persistence across restarts
    ipcMain.handle("get-dictation-key", async () => {
      return this.environmentManager.getDictationKey();
    });

    ipcMain.handle("save-dictation-key", async (event, key) => {
      return this.environmentManager.saveDictationKey(key);
    });

    ipcMain.handle("save-anthropic-key", async (event, key) => {
      return this.environmentManager.saveAnthropicKey(key);
    });

    ipcMain.handle("save-all-keys-to-env", async () => {
      return this.environmentManager.saveAllKeysToEnvFile();
    });

    ipcMain.on("transcription-settings-changed", (_event, settings = {}) => {
      this.broadcastToWindows("transcription-settings-changed", settings);
    });

    ipcMain.handle("sync-startup-preferences", async (event, prefs) => {
      if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) {
        return { success: false, synced: false };
      }
      const setVars = {};
      const clearVars = [];

      if (
        typeof prefs.whisperServerIdleTimeoutMinutes === "number" &&
        Number.isFinite(prefs.whisperServerIdleTimeoutMinutes)
      ) {
        // Persist as env var so it applies at next cold start.
        setVars.WHISPER_SERVER_IDLE_TIMEOUT_MINUTES = String(
          Math.max(0, Math.floor(prefs.whisperServerIdleTimeoutMinutes))
        );
        if (this.whisperManager) {
          this.whisperManager.setServerIdleTimeoutMinutes(
            Math.max(0, Math.floor(prefs.whisperServerIdleTimeoutMinutes))
          );
        }
      } else {
        clearVars.push("WHISPER_SERVER_IDLE_TIMEOUT_MINUTES");
      }

      if (
        typeof prefs.parakeetServerIdleTimeoutMinutes === "number" &&
        Number.isFinite(prefs.parakeetServerIdleTimeoutMinutes)
      ) {
        setVars.PARAKEET_SERVER_IDLE_TIMEOUT_MINUTES = String(
          Math.max(0, Math.floor(prefs.parakeetServerIdleTimeoutMinutes))
        );
        // Apply immediately if the parakeet manager is running.
        if (this.parakeetManager) {
          this.parakeetManager.setServerIdleTimeoutMinutes(
            Math.max(0, Math.floor(prefs.parakeetServerIdleTimeoutMinutes))
          );
        }
      } else {
        clearVars.push("PARAKEET_SERVER_IDLE_TIMEOUT_MINUTES");
      }

      if (
        typeof prefs.llamaServerIdleTimeoutMinutes === "number" &&
        Number.isFinite(prefs.llamaServerIdleTimeoutMinutes)
      ) {
        setVars.LLAMA_SERVER_IDLE_TIMEOUT_MINUTES = String(
          Math.max(0, Math.floor(prefs.llamaServerIdleTimeoutMinutes))
        );
        // Apply immediately if the llama server is running.
        try {
          const modelManager = require("../helpers/modelManagerBridge").default;
          modelManager.setServerIdleTimeoutMinutes(
            Math.max(0, Math.floor(prefs.llamaServerIdleTimeoutMinutes))
          );
        } catch {
          // Non-fatal: manager may not be initialized yet
        }
      } else {
        clearVars.push("LLAMA_SERVER_IDLE_TIMEOUT_MINUTES");
      }

      if (typeof prefs.whisperForceCpu === "boolean") {
        if (prefs.whisperForceCpu) {
          setVars.WHISPER_FORCE_CPU = "true";
        } else {
          clearVars.push("WHISPER_FORCE_CPU");
        }
        if (this.whisperManager) {
          this.whisperManager.setForceCpu(prefs.whisperForceCpu).catch(() => {});
        }
      }
      // Startup no longer pre-warms local transcription servers.
      // Clear any stale pre-warm vars from prior versions.
      clearVars.push("LOCAL_TRANSCRIPTION_PROVIDER", "PARAKEET_MODEL", "LOCAL_WHISPER_MODEL");

      if (prefs.reasoningProvider === "local" && prefs.reasoningModel) {
        setVars.REASONING_PROVIDER = "local";
        setVars.LOCAL_REASONING_MODEL = prefs.reasoningModel;
      } else if (prefs.reasoningProvider && prefs.reasoningProvider !== "local") {
        clearVars.push("REASONING_PROVIDER", "LOCAL_REASONING_MODEL");
      }

      this._syncStartupEnv(setVars, clearVars);
      return { success: true, synced: true };
    });

    // Local reasoning handler
    ipcMain.handle("process-local-reasoning", async (event, text, modelId, agentName, config) => {
      try {
        const LocalReasoningService = require("../services/localReasoningBridge").default;
        const result = await LocalReasoningService.processText(text, modelId, agentName, {
          ...config,
          customDictionary: this._getDictionarySafe(),
        });
        return { success: true, text: result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // Anthropic reasoning handler
    ipcMain.handle(
      "process-anthropic-reasoning",
      async (event, text, modelId, agentName, config) => {
        try {
          const apiKey = this.environmentManager.getAnthropicKey();

          if (!apiKey) {
            throw new Error("Anthropic API key not configured");
          }

          const systemPrompt = getSystemPrompt(
            agentName,
            this._getDictionarySafe(),
            config?.dictationMode
          );
          const userPrompt = text;

          if (!modelId) {
            throw new Error("No model specified for Anthropic API call");
          }

          const requestBody = {
            model: modelId,
            messages: [{ role: "user", content: userPrompt }],
            system: systemPrompt,
            max_tokens: config?.maxTokens || Math.max(100, Math.min(text.length * 2, 4096)),
            temperature: config?.temperature || 0.3,
          };

          const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-API-Key": apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify(requestBody),
          });

          if (!response.ok) {
            const errorText = await response.text();
            let errorData = { error: response.statusText };
            try {
              errorData = JSON.parse(errorText);
            } catch {
              errorData = { error: errorText || response.statusText };
            }
            throw new Error(
              errorData.error?.message ||
                errorData.error ||
                `Anthropic API error: ${response.status}`
            );
          }

          const data = await response.json();
          return { success: true, text: data.content[0].text.trim() };
        } catch (error) {
          debugLogger.error("Anthropic reasoning error:", error);
          return { success: false, error: error.message };
        }
      }
    );

    // Check if local reasoning is available
    ipcMain.handle("check-local-reasoning-available", async () => {
      try {
        const LocalReasoningService = require("../services/localReasoningBridge").default;
        return await LocalReasoningService.isAvailable();
      } catch (error) {
        return false;
      }
    });

    // llama-server management handlers
    ipcMain.handle("llama-server-start", async (event, modelId) => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        const modelInfo = modelManager.findModelById(modelId);
        if (!modelInfo) {
          return { success: false, error: `Model "${modelId}" not found` };
        }

        // Guard against path traversal: model filenames must be simple names with no separators.
        if (!isSafeModelFilename(modelInfo.model.fileName)) {
          debugLogger.error("llama-server-start blocked unsafe model filename", {
            fileName: modelInfo.model.fileName,
          });
          return { success: false, error: "Invalid model filename" };
        }

        const modelPath = require("path").join(modelManager.modelsDir, modelInfo.model.fileName);

        await modelManager.serverManager.start(modelPath, {
          contextSize: modelInfo.model.contextLength || 4096,
          threads: 4,
        });
        modelManager.currentServerModelId = modelId;

        return { success: true, port: modelManager.serverManager.port };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("llama-server-stop", async () => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        await modelManager.stopServer();
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("llama-server-status", async () => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        return modelManager.getServerStatus();
      } catch (error) {
        return { available: false, running: false, error: error.message };
      }
    });

    ipcMain.handle("get-log-level", async () => {
      return debugLogger.getLevel();
    });

    ipcMain.handle("app-log", async (event, entry) => {
      debugLogger.logEntry(entry);
      return { success: true };
    });

    const SYSTEM_SETTINGS_URLS = {
      darwin: {
        microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        sound: "x-apple.systempreferences:com.apple.preference.sound?input",
        accessibility:
          "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      },
      win32: {
        microphone: "ms-settings:privacy-microphone",
        sound: "ms-settings:sound",
        // Windows Accessibility / Ease of Access settings
        accessibility: "ms-settings:easeofaccess",
      },
    };

    const LINUX_SETTINGS_COMMANDS = {
      microphone: [
        // Most Linux distros don't have a single privacy/microphone permissions panel,
        // so we fall back to opening sound settings where users can select an input.
        ["gnome-control-center", ["sound"]],
        ["systemsettings5", ["kcmshell5", "kcm_pulseaudio"]],
        ["pavucontrol", []],
      ],
      sound: [
        ["gnome-control-center", ["sound"]],
        ["systemsettings5", ["kcmshell5", "kcm_pulseaudio"]],
        ["pavucontrol", []],
      ],
      accessibility: [
        ["gnome-control-center", ["universal-access"]],
        ["systemsettings5", ["kcmshell5", "kcm_accessibility"]],
      ],
    };

    const openLinuxSettings = async (settingType) => {
      const candidates = LINUX_SETTINGS_COMMANDS[settingType] || [];

      for (const [cmd, args] of candidates) {
        try {
          // Use execFile (no shell) to avoid command injection.
          await execFileAsync(cmd, args, { timeout: 10_000 });
          return { success: true };
        } catch (error) {
          // Keep trying next candidate.
          debugLogger.warn(`Linux settings launcher failed: ${cmd} ${args.join(" ")}`, error);
        }
      }

      const messages = {
        microphone:
          "Unable to open microphone settings automatically. Please open your system sound settings (e.g., pavucontrol) to select an input device.",
        sound:
          "Unable to open sound settings automatically. Please open your system sound settings (e.g., pavucontrol).",
        accessibility:
          "Unable to open accessibility settings automatically. Please open your desktop environment settings manually.",
      };

      return {
        success: false,
        error:
          messages[settingType] || `${settingType} settings are not available on this platform.`,
      };
    };

    const openSystemSettings = async (settingType) => {
      const platform = process.platform;

      if (platform === "linux") {
        return openLinuxSettings(settingType);
      }

      const urls = SYSTEM_SETTINGS_URLS[platform];
      const url = urls?.[settingType];

      if (!url) {
        // Platform doesn't support this settings URL
        const messages = {
          microphone: "Please open your system settings to configure microphone permissions.",
          sound: "Please open your system sound settings.",
          accessibility: "Accessibility settings are not applicable on this platform.",
        };
        return {
          success: false,
          error:
            messages[settingType] || `${settingType} settings are not available on this platform.`,
        };
      }

      try {
        await shell.openExternal(url);
        return { success: true };
      } catch (error) {
        debugLogger.error(`Failed to open ${settingType} settings:`, error);
        return { success: false, error: error.message };
      }
    };

    ipcMain.handle("open-microphone-settings", () => openSystemSettings("microphone"));
    ipcMain.handle("open-sound-input-settings", () => openSystemSettings("sound"));
    ipcMain.handle("open-accessibility-settings", () => openSystemSettings("accessibility"));

    ipcMain.handle("open-whisper-models-folder", async () => {
      try {
        const modelsDir = this.whisperManager.getModelsDir();
        await shell.openPath(modelsDir);
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to open whisper models folder:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("open-uninstall-location", async () => {
      try {
        if (process.platform === "win32") {
          await shell.openExternal("ms-settings:appsfeatures");
          return { success: true };
        }

        if (process.platform === "darwin") {
          const result = await shell.openPath("/Applications");
          if (result) {
            return { success: false, error: result };
          }
          return { success: true };
        }

        return {
          success: false,
          error:
            "Please use your package manager or software center to uninstall PrivateTranscribe.",
        };
      } catch (error) {
        debugLogger.error("Failed to open uninstall location:", error);
        return { success: false, error: error.message };
      }
    });

    // Debug logging handlers
    ipcMain.handle("get-debug-state", async () => {
      try {
        return {
          enabled: debugLogger.isEnabled(),
          logPath: debugLogger.getLogPath(),
          logLevel: debugLogger.getLevel(),
        };
      } catch (error) {
        debugLogger.error("Failed to get debug state:", error);
        return { enabled: false, logPath: null, logLevel: "info" };
      }
    });

    ipcMain.handle("set-debug-logging", async (event, enabled) => {
      try {
        const path = require("path");
        const fs = require("fs");
        const envPath = path.join(app.getPath("userData"), ".env");

        // Read current .env content
        let envContent = "";
        if (fs.existsSync(envPath)) {
          envContent = fs.readFileSync(envPath, "utf8");
        }

        // Parse lines
        const lines = envContent.split("\n");
        const logLevelIndex = lines.findIndex((line) => line.trim().startsWith("PT_LOG_LEVEL="));

        if (enabled) {
          // Set to debug
          if (logLevelIndex !== -1) {
            lines[logLevelIndex] = "PT_LOG_LEVEL=debug";
          } else {
            // Add new line
            if (lines.length > 0 && lines[lines.length - 1] !== "") {
              lines.push("");
            }
            lines.push("# Debug logging setting");
            lines.push("PT_LOG_LEVEL=debug");
          }
        } else {
          // Remove or set to info
          if (logLevelIndex !== -1) {
            lines[logLevelIndex] = "PT_LOG_LEVEL=info";
          }
        }

        // Write back
        fs.writeFileSync(envPath, lines.join("\n"), "utf8");

        // Update environment variable
        process.env.PT_LOG_LEVEL = enabled ? "debug" : "info";

        // Refresh logger state
        debugLogger.refreshLogLevel();

        return {
          success: true,
          enabled: debugLogger.isEnabled(),
          logPath: debugLogger.getLogPath(),
        };
      } catch (error) {
        debugLogger.error("Failed to set debug logging:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("open-logs-folder", async () => {
      try {
        const logsDir = path.join(app.getPath("userData"), "logs");
        await shell.openPath(logsDir);
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to open logs folder:", error);
        return { success: false, error: error.message };
      }
    });

    // Hardware detection handler
    ipcMain.handle("detect-hardware", async () => {
      try {
        const detection = await this.hardwareDetector.detectHardware();
        return { success: true, detection };
      } catch (error) {
        debugLogger.error("Hardware detection failed:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("clear-hardware-cache", async () => {
      this.hardwareDetector.clearCache();
      return { success: true };
    });

    // Benchmark (transcription speed test)
    if (this.benchmarkManager) {
      ipcMain.handle("benchmark-run", async (_event, options) => {
        try {
          const result = await this.benchmarkManager.run(options);
          return { success: true, result };
        } catch (error) {
          debugLogger.error("Benchmark failed:", error);
          return { success: false, error: error.message };
        }
      });

      ipcMain.handle("benchmark-get-latest", async (_event, provider) => {
        try {
          const result = this.benchmarkManager.getLatest(provider || undefined);
          return { success: true, result };
        } catch (error) {
          return { success: false, error: error.message };
        }
      });

      ipcMain.handle("benchmark-run-comparison", async (_event, options) => {
        try {
          const result = await this.benchmarkManager.runComparison(options || {});
          return { success: true, result };
        } catch (error) {
          debugLogger.error("Comparison benchmark failed:", error);
          return { success: false, error: error.message };
        }
      });

      ipcMain.handle("benchmark-get-latest-comparison", async () => {
        try {
          const result = this.benchmarkManager.getLatestComparison();
          return { success: true, result };
        } catch (error) {
          return { success: false, error: error.message };
        }
      });
    }

    // Update handlers
    ipcMain.handle("check-for-updates", async () => {
      return this.updateManager.checkForUpdates();
    });

    ipcMain.handle("download-update", async () => {
      return this.updateManager.downloadUpdate();
    });

    ipcMain.handle("install-update", async () => {
      return this.updateManager.installUpdate();
    });

    ipcMain.handle("get-app-version", async () => {
      return this.updateManager.getAppVersion();
    });

    ipcMain.handle("get-update-status", async () => {
      return this.updateManager.getUpdateStatus();
    });

    ipcMain.handle("get-update-info", async () => {
      return this.updateManager.getUpdateInfo();
    });

    // Audio ducking - mute or lower system volume during transcription
    ipcMain.handle("duck-system-audio", async (_event, options = {}) => {
      debugLogger.info("[IPC] duck-system-audio received", options);
      try {
        await audioDuckingManager.duck({
          mode: options.mode || "duck",
          duckLevel: typeof options.duckLevel === "number" ? options.duckLevel : 0.2,
        });
        return { success: true };
      } catch (err) {
        debugLogger.warn("[IPC] duck-system-audio failed:", err.message);
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle("restore-system-audio", async () => {
      debugLogger.info("[IPC] restore-system-audio received");
      try {
        await audioDuckingManager.restore();
        return { success: true };
      } catch (err) {
        debugLogger.warn("[IPC] restore-system-audio failed:", err.message);
        return { success: false, error: err.message };
      }
    });

    // Media pause — stop playing media while recording, resume when done
    ipcMain.handle("media-pause", async () => {
      try {
        await mediaController.pauseMedia();
      } catch (_) {
        // Fail silently
      }
      return { success: true };
    });

    ipcMain.handle("media-resume", async () => {
      try {
        // resumeMedia() is async — it awaits any in-flight pauseMedia() state
        // check before deciding whether to send the resume key.
        await mediaController.resumeMedia();
      } catch (_) {
        // Fail silently
      }
      return { success: true };
    });

    // Licensing - stable device identifier
    ipcMain.handle("get-machine-id", async () => {
      try {
        const { machineIdSync } = require("node-machine-id");
        return { id: machineIdSync(false) };
      } catch {
        // Fallback: use a persisted random ID
        const path = require("path");
        const fs = require("fs");
        const { app } = require("electron");
        const idPath = path.join(app.getPath("userData"), ".device-id");
        if (fs.existsSync(idPath)) {
          return { id: fs.readFileSync(idPath, "utf-8").trim() };
        }
        const crypto = require("crypto");
        const id = crypto.randomUUID();
        fs.writeFileSync(idPath, id, "utf-8");
        return { id };
      }
    });

    // Native file-open dialog - used by Action Engine "Open application" and other pickers.
    // The dialog is always shown as a sheet attached to the requesting window, so the user
    // explicitly chooses a path; no sensitive data is exposed without interaction.
    ipcMain.handle("show-open-dialog", async (event, options) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const safeOptions = {
        title: typeof options?.title === "string" ? options.title : "Select file",
        defaultPath: typeof options?.defaultPath === "string" ? options.defaultPath : undefined,
        properties: Array.isArray(options?.properties) ? options.properties : ["openFile"],
        filters: Array.isArray(options?.filters) ? options.filters : [],
      };
      const result = await dialog.showOpenDialog(win ?? undefined, safeOptions);
      return result; // { canceled: boolean; filePaths: string[] }
    });

    // Analytics consent
    const analyticsManager = require("./analyticsManager");
    ipcMain.handle("analytics-needs-consent", () => {
      try {
        return analyticsManager.needsConsentPrompt();
      } catch (err) {
        debugLogger.error("[IPC:analytics-needs-consent] error:", err.message);
        return false;
      }
    });
    ipcMain.handle("analytics-set-consent", (_e, granted) => {
      try {
        return analyticsManager.setConsent(granted);
      } catch (err) {
        debugLogger.error("[IPC:analytics-set-consent] error:", err.message);
        return { success: false, error: err.message };
      }
    });
    ipcMain.handle("analytics-track", (_e, event, extra) => {
      try {
        return analyticsManager.track(event, extra);
      } catch (err) {
        debugLogger.error("[IPC:analytics-track] error:", err.message);
        return { success: false, error: err.message };
      }
    });

    if (this.actionEngineManager) {
      this._setupActionEngineHandlers();
    }
  }

  // ── Action Engine (Pro feature) ──────────────────────────────────────────
  // Called from setupHandlers() only when actionEngineManager is present.

  _setupActionEngineHandlers() {
    const mgr = this.actionEngineManager;

    ipcMain.handle("action-engine-list", () => {
      try {
        return { success: true, actions: mgr.listActions() };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle("action-engine-create", (_event, payload) => {
      try {
        const action = mgr.createAction(payload);
        return { success: true, action };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle("action-engine-update", (_event, id, patch) => {
      try {
        const action = mgr.updateAction(id, patch);
        return { success: true, action };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle("action-engine-delete", (_event, id) => {
      try {
        const result = mgr.deleteAction(id);
        return { success: result.success };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle("action-engine-toggle", (_event, id, enabled) => {
      try {
        const action = mgr.setActionEnabled(id, enabled);
        return { success: true, action };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle("action-engine-execute", async (_event, id, runOptions) => {
      try {
        const result = await mgr.executeById(
          id,
          { windowManager: this.windowManager },
          runOptions || {}
        );
        return result;
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle("action-engine-match", (_event, transcript) => {
      try {
        const matches = mgr.matchTranscript(transcript);
        return { success: true, matches };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle("action-engine-runs-list", (_event, limit) => {
      try {
        const runs = mgr.listRuns(limit ?? 50);
        return { success: true, runs };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle("action-engine-runs-clear", () => {
      try {
        return mgr.clearRuns();
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle("action-engine-runs-prune", (_event, maxRuns) => {
      try {
        return mgr.pruneRuns(maxRuns ?? 0);
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle("action-engine-list-apps", async () => {
      try {
        const { listInstalledApps } = require("./appDiscovery");
        const apps = listInstalledApps();
        return { success: true, apps };
      } catch (err) {
        return { success: false, error: err.message, apps: [] };
      }
    });
  }

  broadcastToWindows(channel, payload) {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    });
  }
}

module.exports = IPCHandlers;
