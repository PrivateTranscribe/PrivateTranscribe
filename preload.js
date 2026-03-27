const { contextBridge, ipcRenderer } = require("electron");

/**
 * Helper to register an IPC listener and return a cleanup function.
 * Ensures renderer code can easily remove listeners to avoid leaks.
 */
const registerListener = (channel, handlerFactory) => {
  return (callback) => {
    if (typeof callback !== "function") {
      return () => {};
    }

    const listener =
      typeof handlerFactory === "function"
        ? handlerFactory(callback)
        : (event, ...args) => callback(event, ...args);

    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  };
};

contextBridge.exposeInMainWorld("electronAPI", {
  pasteText: (text) => ipcRenderer.invoke("paste-text", text),
  hideWindow: () => ipcRenderer.invoke("hide-window"),
  showDictationPanel: () => ipcRenderer.invoke("show-dictation-panel"),
  openControlPanel: () => ipcRenderer.invoke("open-control-panel"),
  onToggleDictation: registerListener("toggle-dictation", (callback) => () => callback()),
  onStartDictation: registerListener("start-dictation", (callback) => () => callback()),
  onStopDictation: registerListener("stop-dictation", (callback) => () => callback()),

  // Database functions
  saveTranscription: (text, durationSeconds, options) =>
    ipcRenderer.invoke("db-save-transcription", text, durationSeconds, options),
  getTranscriptions: (limit) => ipcRenderer.invoke("db-get-transcriptions", limit),
  clearTranscriptions: () => ipcRenderer.invoke("db-clear-transcriptions"),
  deleteTranscription: (id) => ipcRenderer.invoke("db-delete-transcription", id),
  trimTranscriptions: (limit) => ipcRenderer.invoke("db-trim-transcriptions", limit),
  setHistoryLimit: (limit) => ipcRenderer.invoke("set-history-limit", limit),
  // Dictionary functions
  getDictionary: () => ipcRenderer.invoke("db-get-dictionary"),
  setDictionary: (words) => ipcRenderer.invoke("db-set-dictionary", words),

  // Correction memory
  getCorrectionMemory: (limit) => ipcRenderer.invoke("db-get-correction-memory", limit),
  upsertCorrection: (source, target) => ipcRenderer.invoke("db-upsert-correction", source, target),
  confirmCorrection: (source, target) =>
    ipcRenderer.invoke("db-confirm-correction", source, target),
  deleteCorrection: (source) => ipcRenderer.invoke("db-delete-correction", source),

  // Stats functions
  getStats: () => ipcRenderer.invoke("db-get-stats"),
  resetStats: () => ipcRenderer.invoke("db-reset-stats"),
  getStreakDates: () => ipcRenderer.invoke("db-get-streak-dates"),

  onTranscriptionAdded: (callback) => {
    const listener = (_event, transcription) => callback?.(transcription);
    ipcRenderer.on("transcription-added", listener);
    return () => ipcRenderer.removeListener("transcription-added", listener);
  },
  onTranscriptionDeleted: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("transcription-deleted", listener);
    return () => ipcRenderer.removeListener("transcription-deleted", listener);
  },
  onTranscriptionsCleared: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("transcriptions-cleared", listener);
    return () => ipcRenderer.removeListener("transcriptions-cleared", listener);
  },
  onTranscriptionsReloaded: (callback) => {
    const listener = (_event, items) => callback?.(items);
    ipcRenderer.on("transcriptions-reloaded", listener);
    return () => ipcRenderer.removeListener("transcriptions-reloaded", listener);
  },

  // Environment variables
  getOpenAIKey: () => ipcRenderer.invoke("get-openai-key"),
  saveOpenAIKey: (key) => ipcRenderer.invoke("save-openai-key", key),
  createProductionEnvFile: (key) => ipcRenderer.invoke("create-production-env-file", key),

  // Clipboard functions
  readClipboard: () => ipcRenderer.invoke("read-clipboard"),
  writeClipboard: (text) => ipcRenderer.invoke("write-clipboard", text),
  showNotification: (title, body) => ipcRenderer.invoke("show-notification", title, body),
  checkPasteTools: () => ipcRenderer.invoke("check-paste-tools"),

  // Context capture (best-effort; returns {available:false} if unsupported)
  getActiveWindowContext: () => ipcRenderer.invoke("get-active-window-context"),
  // File identifier extraction for Smart Context (opt-in, local only)
  extractFileIdentifiers: (filename) => ipcRenderer.invoke("extract-file-identifiers", filename),
  // File content extraction for LLM Context Enhancement (opt-in, local only)
  extractFileContext: (filename, options) =>
    ipcRenderer.invoke("extract-file-context", filename, options),

  // Local Whisper functions (whisper.cpp)
  transcribeLocalWhisper: (audioBlob, options) =>
    ipcRenderer.invoke("transcribe-local-whisper", audioBlob, options),
  checkWhisperInstallation: () => ipcRenderer.invoke("check-whisper-installation"),
  downloadWhisperModel: (modelName) => ipcRenderer.invoke("download-whisper-model", modelName),
  onWhisperDownloadProgress: registerListener("whisper-download-progress"),
  checkModelStatus: (modelName) => ipcRenderer.invoke("check-model-status", modelName),
  listWhisperModels: () => ipcRenderer.invoke("list-whisper-models"),
  deleteWhisperModel: (modelName) => ipcRenderer.invoke("delete-whisper-model", modelName),
  deleteAllWhisperModels: () => ipcRenderer.invoke("delete-all-whisper-models"),
  cancelWhisperDownload: () => ipcRenderer.invoke("cancel-whisper-download"),
  checkFFmpegAvailability: () => ipcRenderer.invoke("check-ffmpeg-availability"),
  getAudioDiagnostics: () => ipcRenderer.invoke("get-audio-diagnostics"),

  // Whisper server functions (faster repeated transcriptions)
  whisperServerStart: (modelName) => ipcRenderer.invoke("whisper-server-start", modelName),
  whisperServerStop: () => ipcRenderer.invoke("whisper-server-stop"),
  whisperServerStatus: () => ipcRenderer.invoke("whisper-server-status"),
  whisperServerSetIdleTimeoutMinutes: (minutes) =>
    ipcRenderer.invoke("whisper-server-set-idle-timeout-minutes", minutes),

  // Local Parakeet (NVIDIA) functions
  transcribeLocalParakeet: (audioBlob, options) =>
    ipcRenderer.invoke("transcribe-local-parakeet", audioBlob, options),
  checkParakeetInstallation: () => ipcRenderer.invoke("check-parakeet-installation"),
  downloadParakeetModel: (modelName) => ipcRenderer.invoke("download-parakeet-model", modelName),
  onParakeetDownloadProgress: registerListener("parakeet-download-progress"),
  checkParakeetModelStatus: (modelName) =>
    ipcRenderer.invoke("check-parakeet-model-status", modelName),
  listParakeetModels: () => ipcRenderer.invoke("list-parakeet-models"),
  deleteParakeetModel: (modelName) => ipcRenderer.invoke("delete-parakeet-model", modelName),
  deleteAllParakeetModels: () => ipcRenderer.invoke("delete-all-parakeet-models"),
  cancelParakeetDownload: () => ipcRenderer.invoke("cancel-parakeet-download"),
  getParakeetDiagnostics: () => ipcRenderer.invoke("get-parakeet-diagnostics"),

  // Parakeet server functions (faster repeated transcriptions)
  parakeetServerStart: (modelName) => ipcRenderer.invoke("parakeet-server-start", modelName),
  parakeetServerStop: () => ipcRenderer.invoke("parakeet-server-stop"),
  parakeetServerStatus: () => ipcRenderer.invoke("parakeet-server-status"),
  parakeetServerSetIdleTimeoutMinutes: (minutes) =>
    ipcRenderer.invoke("parakeet-server-set-idle-timeout-minutes", minutes),

  // Local llama-server functions
  llamaServerSetIdleTimeoutMinutes: (minutes) =>
    ipcRenderer.invoke("llama-server-set-idle-timeout-minutes", minutes),

  // Window control functions
  windowMinimize: () => ipcRenderer.invoke("window-minimize"),
  windowMaximize: () => ipcRenderer.invoke("window-maximize"),
  windowClose: () => ipcRenderer.invoke("window-close"),
  windowIsMaximized: () => ipcRenderer.invoke("window-is-maximized"),
  getPlatform: () => process.platform,
  appQuit: () => ipcRenderer.invoke("app-quit"),

  // Cleanup function
  cleanupApp: () => ipcRenderer.invoke("cleanup-app"),
  updateHotkey: (hotkey) => ipcRenderer.invoke("update-hotkey", hotkey),
  setHotkeyListeningMode: (enabled, newHotkey) =>
    ipcRenderer.invoke("set-hotkey-listening-mode", enabled, newHotkey),
  getHotkeyModeInfo: () => ipcRenderer.invoke("get-hotkey-mode-info"),
  startWindowDrag: () => ipcRenderer.invoke("start-window-drag"),
  stopWindowDrag: () => ipcRenderer.invoke("stop-window-drag"),
  setMainWindowInteractivity: (interactive) =>
    ipcRenderer.invoke("set-main-window-interactivity", interactive),
  resizeMainWindow: (sizeKey) => ipcRenderer.invoke("resize-main-window", sizeKey),

  // Update functions
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  downloadUpdate: () => ipcRenderer.invoke("download-update"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  getUpdateStatus: () => ipcRenderer.invoke("get-update-status"),
  getUpdateInfo: () => ipcRenderer.invoke("get-update-info"),

  // Update event listeners
  onUpdateAvailable: registerListener("update-available"),
  onUpdateNotAvailable: registerListener("update-not-available"),
  onUpdateDownloaded: registerListener("update-downloaded"),
  onUpdateDownloadProgress: registerListener("update-download-progress"),
  onUpdateError: registerListener("update-error"),

  // Audio event listeners
  onNoAudioDetected: registerListener("no-audio-detected"),

  // External link opener
  openExternal: (url) => ipcRenderer.invoke("open-external", url),

  // Model management functions
  modelGetAll: () => ipcRenderer.invoke("model-get-all"),
  modelCheck: (modelId) => ipcRenderer.invoke("model-check", modelId),
  modelDownload: (modelId) => ipcRenderer.invoke("model-download", modelId),
  modelDelete: (modelId) => ipcRenderer.invoke("model-delete", modelId),
  modelDeleteAll: () => ipcRenderer.invoke("model-delete-all"),
  modelCheckRuntime: () => ipcRenderer.invoke("model-check-runtime"),
  modelCancelDownload: (modelId) => ipcRenderer.invoke("model-cancel-download", modelId),
  onModelDownloadProgress: registerListener("model-download-progress"),

  // Anthropic API
  getAnthropicKey: () => ipcRenderer.invoke("get-anthropic-key"),
  saveAnthropicKey: (key) => ipcRenderer.invoke("save-anthropic-key", key),

  // Gemini API
  getGeminiKey: () => ipcRenderer.invoke("get-gemini-key"),
  saveGeminiKey: (key) => ipcRenderer.invoke("save-gemini-key", key),

  // Groq API
  getGroqKey: () => ipcRenderer.invoke("get-groq-key"),
  saveGroqKey: (key) => ipcRenderer.invoke("save-groq-key", key),

  // Custom endpoint API keys
  getCustomTranscriptionKey: () => ipcRenderer.invoke("get-custom-transcription-key"),
  saveCustomTranscriptionKey: (key) => ipcRenderer.invoke("save-custom-transcription-key", key),
  getCustomReasoningKey: () => ipcRenderer.invoke("get-custom-reasoning-key"),
  saveCustomReasoningKey: (key) => ipcRenderer.invoke("save-custom-reasoning-key", key),

  // Dictation key persistence (file-based for reliable startup)
  getDictationKey: () => ipcRenderer.invoke("get-dictation-key"),
  saveDictationKey: (key) => ipcRenderer.invoke("save-dictation-key", key),

  // Analytics
  analyticsNeedsConsent: () => ipcRenderer.invoke("analytics-needs-consent"),
  analyticsSetConsent: (granted) => ipcRenderer.invoke("analytics-set-consent", granted),
  analyticsTrack: (event, extra) => ipcRenderer.invoke("analytics-track", event, extra),

  saveAllKeysToEnv: () => ipcRenderer.invoke("save-all-keys-to-env"),
  syncStartupPreferences: (prefs) => ipcRenderer.invoke("sync-startup-preferences", prefs),

  // Local reasoning
  processLocalReasoning: (text, modelId, agentName, config) =>
    ipcRenderer.invoke("process-local-reasoning", text, modelId, agentName, config),
  checkLocalReasoningAvailable: () => ipcRenderer.invoke("check-local-reasoning-available"),

  // Anthropic reasoning
  processAnthropicReasoning: (text, modelId, agentName, config) =>
    ipcRenderer.invoke("process-anthropic-reasoning", text, modelId, agentName, config),

  // llama.cpp
  llamaCppCheck: () => ipcRenderer.invoke("llama-cpp-check"),
  llamaCppInstall: () => ipcRenderer.invoke("llama-cpp-install"),
  llamaCppUninstall: () => ipcRenderer.invoke("llama-cpp-uninstall"),

  // llama-server
  llamaServerStart: (modelId) => ipcRenderer.invoke("llama-server-start", modelId),
  llamaServerStop: () => ipcRenderer.invoke("llama-server-stop"),
  llamaServerStatus: () => ipcRenderer.invoke("llama-server-status"),

  getLogLevel: () => ipcRenderer.invoke("get-log-level"),
  log: (entry) => ipcRenderer.invoke("app-log", entry),

  // Debug logging management
  getDebugState: () => ipcRenderer.invoke("get-debug-state"),
  setDebugLogging: (enabled) => ipcRenderer.invoke("set-debug-logging", enabled),
  openLogsFolder: () => ipcRenderer.invoke("open-logs-folder"),

  // System settings helpers for microphone/audio permissions
  openMicrophoneSettings: () => ipcRenderer.invoke("open-microphone-settings"),
  openSoundInputSettings: () => ipcRenderer.invoke("open-sound-input-settings"),
  openAccessibilitySettings: () => ipcRenderer.invoke("open-accessibility-settings"),
  openWhisperModelsFolder: () => ipcRenderer.invoke("open-whisper-models-folder"),
  openUninstallLocation: () => ipcRenderer.invoke("open-uninstall-location"),

  // Globe key listener for hotkey capture (macOS only)
  onGlobeKeyPressed: (callback) => {
    const listener = () => callback?.();
    ipcRenderer.on("globe-key-pressed", listener);
    return () => ipcRenderer.removeListener("globe-key-pressed", listener);
  },

  // Hotkey registration events (for notifying user when hotkey fails)
  onHotkeyFallbackUsed: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("hotkey-fallback-used", listener);
    return () => ipcRenderer.removeListener("hotkey-fallback-used", listener);
  },
  onHotkeyRegistrationFailed: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("hotkey-registration-failed", listener);
    return () => ipcRenderer.removeListener("hotkey-registration-failed", listener);
  },
  onWindowsPushToTalkUnavailable: registerListener("windows-ptt-unavailable"),

  // Notify main process of activation mode changes (for Windows Push-to-Talk)
  notifyActivationModeChanged: (mode) => ipcRenderer.send("activation-mode-changed", mode),
  notifyHotkeyChanged: (hotkey) => ipcRenderer.send("hotkey-changed", hotkey),
  notifyTranscriptionSettingsChanged: (settings) =>
    ipcRenderer.send("transcription-settings-changed", settings),
  onTranscriptionSettingsChanged: registerListener(
    "transcription-settings-changed",
    (callback) => (_event, settings) => callback?.(settings)
  ),

  // Auto-start management
  getAutoStartEnabled: () => ipcRenderer.invoke("get-auto-start-enabled"),
  setAutoStartEnabled: (enabled) => ipcRenderer.invoke("set-auto-start-enabled", enabled),

  // Hardware detection
  detectHardware: () => ipcRenderer.invoke("detect-hardware"),
  clearHardwareCache: () => ipcRenderer.invoke("clear-hardware-cache"),

  // Benchmark (transcription speed test)
  benchmarkRun: (options) => ipcRenderer.invoke("benchmark-run", options),
  benchmarkGetLatest: (provider) => ipcRenderer.invoke("benchmark-get-latest", provider),
  benchmarkRunComparison: (options) => ipcRenderer.invoke("benchmark-run-comparison", options),
  benchmarkGetLatestComparison: () => ipcRenderer.invoke("benchmark-get-latest-comparison"),

  // Audio ducking — lower/mute system volume while transcribing
  duckSystemAudio: (options) => ipcRenderer.invoke("duck-system-audio", options),
  restoreSystemAudio: () => ipcRenderer.invoke("restore-system-audio"),

  // Media pause — pause playing media while recording, resume when done
  mediaPause: () => ipcRenderer.invoke("media-pause"),
  mediaResume: () => ipcRenderer.invoke("media-resume"),

  // Licensing
  getMachineId: () => ipcRenderer.invoke("get-machine-id"),

  // Native file-open dialog (used by Action Engine app-picker and other UI)
  showOpenDialog: (options) => ipcRenderer.invoke("show-open-dialog", options),

  // Action Engine (Pro feature)
  actionEngineList: () => ipcRenderer.invoke("action-engine-list"),
  actionEngineCreate: (payload) => ipcRenderer.invoke("action-engine-create", payload),
  actionEngineUpdate: (id, patch) => ipcRenderer.invoke("action-engine-update", id, patch),
  actionEngineDelete: (id) => ipcRenderer.invoke("action-engine-delete", id),
  actionEngineToggle: (id, enabled) => ipcRenderer.invoke("action-engine-toggle", id, enabled),
  actionEngineExecute: (id, runOptions) =>
    ipcRenderer.invoke("action-engine-execute", id, runOptions),
  actionEngineMatch: (transcript) => ipcRenderer.invoke("action-engine-match", transcript),
  onActionEngineDictationMode: registerListener("action-engine-dictation-mode"),
  // Action run history
  actionEngineRunsList: (limit) => ipcRenderer.invoke("action-engine-runs-list", limit),
  actionEngineRunsClear: () => ipcRenderer.invoke("action-engine-runs-clear"),
  actionEngineRunsPrune: (maxRuns) => ipcRenderer.invoke("action-engine-runs-prune", maxRuns),
  // Installed app discovery for the "Open application" action picker
  actionEngineListApps: () => ipcRenderer.invoke("action-engine-list-apps"),

  // CUDA binary download
  getCudaBinaryStatus: () => ipcRenderer.invoke("get-cuda-binary-status"),
  downloadCudaBinary: () => ipcRenderer.invoke("download-cuda-binary"),
  cancelCudaBinaryDownload: () => ipcRenderer.invoke("cancel-cuda-binary-download"),
  onCudaBinaryDownloadProgress: registerListener("cuda-binary-download-progress"),
  setWhisperForceCpu: (value) => ipcRenderer.invoke("set-whisper-force-cpu", value),
});
