export type LocalTranscriptionProvider = "whisper" | "nvidia";

export type {
  Action,
  ActionCreatePayload,
  ActionUpdatePayload,
  ActionMatchResult,
  ActionExecuteResult,
} from "./actionEngine";

export interface TranscriptionItem {
  id: number;
  text: string;
  timestamp: string;
  created_at: string;
  include_in_stats: number; // 1 = real dictation (counts toward streak/stats), 0 = file upload etc.
}

export interface WhisperCheckResult {
  installed: boolean;
  working: boolean;
  error?: string;
}

export interface WhisperModelResult {
  success: boolean;
  model: string;
  downloaded: boolean;
  size_mb?: number;
  error?: string;
}

export interface WhisperModelDeleteResult {
  success: boolean;
  model: string;
  deleted: boolean;
  freed_mb?: number;
  error?: string;
}

export interface WhisperModelsListResult {
  success: boolean;
  models: Array<{ model: string; downloaded: boolean; size_mb?: number }>;
  cache_dir: string;
}

export interface FFmpegAvailabilityResult {
  available: boolean;
  path?: string;
  error?: string;
}

export interface AudioDiagnosticsResult {
  platform: string;
  arch: string;
  resourcesPath: string | null;
  isPackaged: boolean;
  ffmpeg: { available: boolean; path: string | null; error: string | null };
  whisperBinary: { available: boolean; path: string | null; error: string | null };
  whisperServer: { available: boolean; path: string | null };
  modelsDir: string;
  models: string[];
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  version?: string;
  releaseDate?: string;
  files?: any[];
  releaseNotes?: string;
  message?: string;
}

export interface UpdateStatusResult {
  updateAvailable: boolean;
  updateDownloaded: boolean;
  isDevelopment: boolean;
}

export interface UpdateInfoResult {
  version?: string;
  releaseDate?: string;
  releaseNotes?: string | null;
  files?: any[];
}

export interface UpdateResult {
  success: boolean;
  message: string;
}

export interface AppVersionResult {
  version: string;
}

export interface WhisperDownloadProgressData {
  type: string;
  model: string;
  percentage?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  error?: string;
  result?: any;
}

export interface ParakeetCheckResult {
  installed: boolean;
  working: boolean;
  path?: string;
}

export interface ParakeetModelResult {
  success: boolean;
  model: string;
  downloaded: boolean;
  path?: string;
  size_bytes?: number;
  size_mb?: number;
  error?: string;
}

export interface ParakeetModelDeleteResult {
  success: boolean;
  model: string;
  deleted: boolean;
  freed_bytes?: number;
  freed_mb?: number;
  error?: string;
}

export interface ParakeetModelsListResult {
  success: boolean;
  models: Array<{ model: string; downloaded: boolean; size_mb?: number }>;
  cache_dir: string;
}

export interface ParakeetDownloadProgressData {
  type: string;
  model: string;
  percentage?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  error?: string;
}

export interface ParakeetTranscriptionResult {
  success: boolean;
  text?: string;
  message?: string;
  error?: string;
}

export interface ParakeetDiagnosticsResult {
  platform: string;
  arch: string;
  resourcesPath: string | null;
  isPackaged: boolean;
  sherpaOnnx: { available: boolean; path: string | null };
  modelsDir: string;
  models: string[];
}

export interface PasteToolsResult {
  platform: "darwin" | "win32" | "linux";
  available: boolean;
  method: string | null;
  requiresPermission: boolean;
  isWayland?: boolean;
  xwaylandAvailable?: boolean;
  tools?: string[];
  recommendedInstall?: string;
}

export interface ActiveWindowContextResult {
  available: boolean;

  /**
   * Human-readable reason for unavailable context.
   * Example: "xdotool not installed" | "sensitive app/window".
   */
  reason?: string;

  /**
   * If true, context capture was intentionally blocked for privacy reasons.
   * (E.g., password managers, OS credential prompts.)
   */
  blocked?: boolean;

  platform?: "darwin" | "win32" | "linux";
  method?: string;

  // Platform-specific, best-effort fields
  appName?: string;
  processName?: string;
  appClass?: string;
  windowTitle?: string;
  windowId?: string;

  // Windows best-effort UIA (focused element) text
  uiaText?: string;
  uiaMethod?: string;
}

export interface FileIdentifiersResult {
  /** Whether identifier extraction succeeded. */
  blocked: boolean;
  /** Identifiers extracted from the file. */
  identifiers: string[];
  /** Base filename that was found and read. */
  filename?: string;
  /** Human-readable reason when blocked or extraction failed. */
  reason?: string;
}

export interface HardwareDetectionCPU {
  count: number;
  model: string;
  speed: number;
}

export interface HardwareDetectionGPU {
  available: boolean;
  vendor: "nvidia" | "amd" | "intel" | "apple" | "unknown" | null;
  model: string | null;
  vram: number | null;
  cuda: { available: boolean; version: string | null };
  metal: { available: boolean; version: string | null };
  directml: { available: boolean };
  rocm: { available: boolean; version: string | null };
}

export type HardwareGpuCategory =
  | "nvidia_cuda" // NVIDIA GPU + CUDA runtime available → Parakeet recommended
  | "nvidia_no_cuda" // NVIDIA GPU detected but CUDA not usable → recovery steps provided
  | "non_nvidia_gpu" // AMD/Intel/other GPU → Whisper on CPU
  | "metal" // macOS Metal GPU (Apple Silicon or Intel Mac) → Whisper with Metal
  | "cpu_only"; // No usable GPU → Whisper on CPU

export interface HardwareRecommendations {
  transcriptionProvider: string;
  localTranscriptionProvider: "whisper" | "nvidia";
  whisperModel: string;
  parakeetModel?: string;
  /**
   * Classifies the detected GPU/acceleration scenario.
   * Used by the UI to render distinct setup states and recovery guidance.
   */
  gpuCategory: HardwareGpuCategory;
  reasoning: string[];
  /**
   * Actionable recovery steps shown when gpuCategory === 'nvidia_no_cuda'.
   * Empty array for all other categories.
   */
  recoverySteps: string[];
}

export interface HardwareDetectionResult {
  timestamp: number;
  platform: string;
  arch: string;
  cpu: HardwareDetectionCPU;
  gpu: HardwareDetectionGPU;
  /**
   * Recommendations are best-effort.
   *
   * The main process should usually provide a non-null object, but renderer UI
   * must handle null safely (e.g. detection ran but recommendations failed).
   */
  recommendations: HardwareRecommendations | null;
}

export interface BenchmarkResult {
  id: string;
  provider: "whisper" | "nvidia";
  model: string;
  gpuCategory: HardwareGpuCategory;
  /** Duration of the test audio sample in seconds. */
  audioDurationSec: number;
  /** Wall-clock time for the transcription engine to process the sample. */
  elapsedMs: number;
  /** audio seconds / processing seconds - higher is faster. */
  realtimeFactor: number;
  gpuModel: string | null;
  cpuModel: string | null;
  cpuCores: number | null;
  createdAt: string;
}

export interface ComparisonBenchmarkResult {
  id: string;
  cpuResult: BenchmarkResult;
  gpuResult: BenchmarkResult;
  /** GPU real-time factor / CPU real-time factor - how many times faster GPU is. */
  speedup: number;
  createdAt: string;
}

export interface AggregateStats {
  total_words: number;
  total_transcriptions: number;
  total_seconds: number;
  average_wpm: number;
  updated_at?: string;
}

export interface SaveTranscriptionOptions {
  includeInStats?: boolean;
}

export interface TranscriptionSettingsBroadcast {
  useLocalWhisper?: string;
  whisperModel?: string;
  localTranscriptionProvider?: LocalTranscriptionProvider;
  parakeetModel?: string;
  allowOpenAIFallback?: string;
  allowLocalFallback?: string;
  fallbackWhisperModel?: string;
  preferredLanguage?: string;
  translateToEnglish?: string;
  cloudTranscriptionProvider?: string;
  cloudTranscriptionModel?: string;
  cloudTranscriptionBaseUrl?: string;
  openaiApiKey?: string;
  groqApiKey?: string;
  customTranscriptionApiKey?: string;
}

declare global {
  interface Window {
    electronAPI: {
      // Basic window operations
      pasteText: (text: string) => Promise<void>;
      hideWindow: () => Promise<void>;
      showDictationPanel: () => Promise<void>;
      openControlPanel?: () => Promise<{ success: boolean }>;
      onToggleDictation: (callback: () => void) => (() => void) | void;
      onStartDictation?: (callback: () => void) => (() => void) | void;
      onStopDictation?: (callback: () => void) => (() => void) | void;

      // Database operations
      saveTranscription: (
        text: string,
        durationSeconds?: number | null,
        options?: SaveTranscriptionOptions
      ) => Promise<{ id: number; success: boolean }>;
      getTranscriptions: (limit?: number) => Promise<TranscriptionItem[]>;
      clearTranscriptions: () => Promise<{ cleared: number; success: boolean }>;
      deleteTranscription: (id: number) => Promise<{ success: boolean }>;
      trimTranscriptions?: (
        limit: number
      ) => Promise<{ trimmed?: number; cleared?: number; success: boolean }>;
      setHistoryLimit?: (limit: number) => Promise<{ success: boolean }>;

      // Dictionary operations
      getDictionary: () => Promise<string[]>;
      setDictionary: (words: string[]) => Promise<{ success: boolean }>;
      getCorrectionMemory: (limit?: number) => Promise<any[]>;
      upsertCorrection: (source: string, target: string) => Promise<{ success: boolean }>;
      confirmCorrection: (source: string, target: string) => Promise<{ success: boolean }>;
      deleteCorrection: (source: string) => Promise<{ success: boolean }>;

      // Stats operations
      getStats: () => Promise<AggregateStats>;
      resetStats: () => Promise<{ success: boolean }>;
      /** Returns distinct "YYYY-MM-DD" date strings for real dictation sessions (last 366 days). */
      getStreakDates: () => Promise<string[]>;

      // Database event listeners
      onTranscriptionAdded?: (callback: (item: TranscriptionItem) => void) => (() => void) | void;
      onTranscriptionDeleted?: (callback: (payload: { id: number }) => void) => (() => void) | void;
      onTranscriptionsCleared?: (
        callback: (payload: { cleared: number }) => void
      ) => (() => void) | void;
      onTranscriptionsReloaded?: (
        callback: (items: TranscriptionItem[]) => void
      ) => (() => void) | void;

      // API key management
      getOpenAIKey: () => Promise<string>;
      saveOpenAIKey: (key: string) => Promise<{ success: boolean }>;
      createProductionEnvFile: (key: string) => Promise<void>;
      getAnthropicKey: () => Promise<string | null>;
      saveAnthropicKey: (key: string) => Promise<void>;
      saveAllKeysToEnv: () => Promise<{ success: boolean; path: string }>;
      syncStartupPreferences: (prefs: {
        useLocalWhisper: boolean;
        localTranscriptionProvider: LocalTranscriptionProvider;
        model?: string;
        whisperServerIdleTimeoutMinutes?: number;
        parakeetServerIdleTimeoutMinutes?: number;
        llamaServerIdleTimeoutMinutes?: number;
        reasoningProvider: string;
        reasoningModel?: string;
      }) => Promise<void>;

      // Clipboard operations
      readClipboard: () => Promise<string>;
      writeClipboard: (text: string) => Promise<{ success: boolean }>;
      checkPasteTools: () => Promise<PasteToolsResult>;

      // Context capture (best-effort; returns {available:false} if unsupported)
      getActiveWindowContext: () => Promise<ActiveWindowContextResult>;
      // File identifier extraction for Smart Context (opt-in, local only)
      extractFileIdentifiers: (filename: string) => Promise<FileIdentifiersResult>;
      // File content extraction for LLM Context Enhancement (opt-in, local only)
      extractFileContext: (
        filename: string,
        options?: { maxChars?: number }
      ) => Promise<{
        blocked?: boolean;
        reason?: string;
        filename?: string;
        excerpt?: string;
        truncated?: boolean;
        originalLength?: number;
      }>;

      // Audio
      onNoAudioDetected: (callback: (event: any, data?: any) => void) => (() => void) | void;

      // Whisper operations (whisper.cpp)
      transcribeLocalWhisper: (audioBlob: Blob | ArrayBuffer, options?: any) => Promise<any>;
      checkWhisperInstallation: () => Promise<WhisperCheckResult>;
      downloadWhisperModel: (modelName: string) => Promise<WhisperModelResult>;
      onWhisperDownloadProgress: (
        callback: (event: any, data: WhisperDownloadProgressData) => void
      ) => (() => void) | void;
      checkModelStatus: (modelName: string) => Promise<WhisperModelResult>;
      listWhisperModels: () => Promise<WhisperModelsListResult>;
      deleteWhisperModel: (modelName: string) => Promise<WhisperModelDeleteResult>;
      deleteAllWhisperModels: () => Promise<{
        success: boolean;
        deleted_count?: number;
        freed_bytes?: number;
        freed_mb?: number;
        error?: string;
      }>;
      cancelWhisperDownload: () => Promise<{
        success: boolean;
        message?: string;
        error?: string;
      }>;

      // whisper-server operations (persistent local server for fast repeat transcriptions)
      whisperServerStart: (modelName: string) => Promise<any>;
      whisperServerStop: () => Promise<any>;
      whisperServerStatus: () => Promise<any>;
      whisperServerSetIdleTimeoutMinutes: (minutes: number) => Promise<any>;

      parakeetServerSetIdleTimeoutMinutes: (minutes: number) => Promise<any>;
      llamaServerSetIdleTimeoutMinutes: (minutes: number) => Promise<any>;

      // Parakeet operations (NVIDIA via sherpa-onnx)
      transcribeLocalParakeet: (
        audioBlob: ArrayBuffer,
        options?: { model?: string; language?: string }
      ) => Promise<ParakeetTranscriptionResult>;
      checkParakeetInstallation: () => Promise<ParakeetCheckResult>;
      downloadParakeetModel: (modelName: string) => Promise<ParakeetModelResult>;
      onParakeetDownloadProgress: (
        callback: (event: any, data: ParakeetDownloadProgressData) => void
      ) => (() => void) | void;
      checkParakeetModelStatus: (modelName: string) => Promise<ParakeetModelResult>;
      listParakeetModels: () => Promise<ParakeetModelsListResult>;
      deleteParakeetModel: (modelName: string) => Promise<ParakeetModelDeleteResult>;
      deleteAllParakeetModels: () => Promise<{
        success: boolean;
        deleted_count?: number;
        freed_bytes?: number;
        freed_mb?: number;
        error?: string;
      }>;
      cancelParakeetDownload: () => Promise<{
        success: boolean;
        message?: string;
        error?: string;
      }>;
      getParakeetDiagnostics: () => Promise<ParakeetDiagnosticsResult>;

      // Local AI model management
      modelGetAll: () => Promise<any[]>;
      modelCheck: (modelId: string) => Promise<boolean>;
      modelDownload: (modelId: string) => Promise<void>;
      modelDelete: (
        modelId: string
      ) => Promise<{ success: boolean; freed_mb?: number; error?: string }>;
      modelDeleteAll: () => Promise<{ success: boolean; error?: string; code?: string }>;
      modelCheckRuntime: () => Promise<boolean>;
      modelCancelDownload: (modelId: string) => Promise<{ success: boolean; error?: string }>;
      onModelDownloadProgress: (callback: (event: any, data: any) => void) => (() => void) | void;

      // Local reasoning
      processLocalReasoning: (
        text: string,
        modelId: string,
        agentName: string | null,
        config: any
      ) => Promise<{ success: boolean; text?: string; error?: string }>;
      checkLocalReasoningAvailable: () => Promise<boolean>;

      // Anthropic reasoning
      processAnthropicReasoning: (
        text: string,
        modelId: string,
        agentName: string | null,
        config: any
      ) => Promise<{ success: boolean; text?: string; error?: string }>;

      // llama.cpp management
      llamaCppCheck: () => Promise<{ isInstalled: boolean; version?: string }>;
      llamaCppInstall: () => Promise<{ success: boolean; error?: string }>;
      llamaCppUninstall: () => Promise<{ success: boolean; error?: string }>;

      // Window control operations
      windowMinimize: () => Promise<void>;
      windowMaximize: () => Promise<void>;
      windowClose: () => Promise<void>;
      windowIsMaximized: () => Promise<boolean>;
      getPlatform: () => string;
      startWindowDrag: () => Promise<void>;
      stopWindowDrag: () => Promise<void>;
      setMainWindowInteractivity: (interactive: boolean) => Promise<void>;

      // App management
      appQuit: () => Promise<void>;
      cleanupApp: () => Promise<{ success: boolean; message: string }>;

      // Update operations
      checkForUpdates: () => Promise<UpdateCheckResult>;
      downloadUpdate: () => Promise<UpdateResult>;
      installUpdate: () => Promise<UpdateResult>;
      getAppVersion: () => Promise<AppVersionResult>;
      getUpdateStatus: () => Promise<UpdateStatusResult>;
      getUpdateInfo: () => Promise<UpdateInfoResult | null>;

      // Update event listeners
      onUpdateAvailable: (callback: (event: any, info: any) => void) => (() => void) | void;
      onUpdateNotAvailable: (callback: (event: any, info: any) => void) => (() => void) | void;
      onUpdateDownloaded: (callback: (event: any, info: any) => void) => (() => void) | void;
      onUpdateDownloadProgress: (
        callback: (event: any, progressObj: any) => void
      ) => (() => void) | void;
      onUpdateError: (callback: (event: any, error: any) => void) => (() => void) | void;

      // External URL operations
      openExternal: (url: string) => Promise<{ success: boolean; error?: string } | void>;

      // Hotkey management
      updateHotkey: (key: string) => Promise<{ success: boolean; message: string }>;
      setHotkeyListeningMode?: (
        enabled: boolean,
        newHotkey?: string | null
      ) => Promise<{ success: boolean }>;
      getHotkeyModeInfo?: () => Promise<{ isUsingGnome: boolean }>;

      // Globe key listener for hotkey capture (macOS only)
      onGlobeKeyPressed?: (callback: () => void) => () => void;

      // Hotkey registration events
      onHotkeyFallbackUsed?: (
        callback: (data: { original: string; fallback: string; message: string }) => void
      ) => () => void;
      onHotkeyRegistrationFailed?: (
        callback: (data: { hotkey: string; error: string; suggestions: string[] }) => void
      ) => () => void;

      // Gemini API key management
      getGeminiKey: () => Promise<string | null>;
      saveGeminiKey: (key: string) => Promise<void>;

      // Groq API key management
      getGroqKey: () => Promise<string | null>;
      saveGroqKey: (key: string) => Promise<void>;

      // Custom endpoint API keys
      getCustomTranscriptionKey?: () => Promise<string | null>;
      saveCustomTranscriptionKey?: (key: string) => Promise<void>;
      getCustomReasoningKey?: () => Promise<string | null>;
      saveCustomReasoningKey?: (key: string) => Promise<void>;

      // Dictation key persistence (file-based for reliable startup)
      getDictationKey?: () => Promise<string | null>;
      saveDictationKey?: (key: string) => Promise<void>;

      // Debug logging
      getLogLevel?: () => Promise<string>;
      log?: (entry: {
        level: string;
        message: string;
        meta?: any;
        scope?: string;
        source?: string;
      }) => Promise<void>;
      getDebugState: () => Promise<{
        enabled: boolean;
        logPath: string | null;
        logLevel: string;
      }>;
      setDebugLogging: (enabled: boolean) => Promise<{
        success: boolean;
        enabled?: boolean;
        logPath?: string | null;
        error?: string;
      }>;
      openLogsFolder: () => Promise<{ success: boolean; error?: string }>;

      // FFmpeg availability
      checkFFmpegAvailability: () => Promise<FFmpegAvailabilityResult>;
      getAudioDiagnostics: () => Promise<AudioDiagnosticsResult>;

      // System settings helpers
      openMicrophoneSettings?: () => Promise<{ success: boolean; error?: string }>;
      openSoundInputSettings?: () => Promise<{ success: boolean; error?: string }>;
      openAccessibilitySettings?: () => Promise<{ success: boolean; error?: string }>;
      openWhisperModelsFolder?: () => Promise<{ success: boolean; error?: string }>;
      openUninstallLocation?: () => Promise<{ success: boolean; error?: string }>;

      // Windows Push-to-Talk notifications
      notifyActivationModeChanged?: (mode: "tap" | "push") => void;
      notifyHotkeyChanged?: (hotkey: string) => void;
      notifyTranscriptionSettingsChanged?: (settings: TranscriptionSettingsBroadcast) => void;
      onTranscriptionSettingsChanged?: (
        callback: (settings: TranscriptionSettingsBroadcast) => void
      ) => (() => void) | void;

      // Auto-start at login
      getAutoStartEnabled?: () => Promise<boolean>;
      setAutoStartEnabled?: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;

      // Hardware detection
      detectHardware?: () => Promise<{
        success: boolean;
        detection?: HardwareDetectionResult;
        error?: string;
      }>;
      clearHardwareCache?: () => Promise<{ success: boolean }>;

      // Benchmark (transcription speed test)
      benchmarkRun?: (options: {
        provider: "whisper" | "nvidia";
        model?: string;
      }) => Promise<{ success: boolean; result?: BenchmarkResult; error?: string }>;
      benchmarkGetLatest?: (
        provider?: string
      ) => Promise<{ success: boolean; result?: BenchmarkResult | null; error?: string }>;
      benchmarkRunComparison?: (options?: { cpuModel?: string; gpuModel?: string }) => Promise<{
        success: boolean;
        result?: ComparisonBenchmarkResult;
        error?: string;
      }>;
      benchmarkGetLatestComparison?: () => Promise<{
        success: boolean;
        result?: ComparisonBenchmarkResult | null;
        error?: string;
      }>;

      // Native file-open dialog
      showOpenDialog?: (options?: {
        title?: string;
        defaultPath?: string;
        properties?: Array<"openFile" | "openDirectory" | "multiSelections">;
        filters?: Array<{ name: string; extensions: string[] }>;
      }) => Promise<{ canceled: boolean; filePaths: string[] }>;

      // Action Engine (Pro feature)
      actionEngineList?: () => Promise<{
        success: boolean;
        actions?: import("./actionEngine").Action[];
        error?: string;
      }>;
      actionEngineCreate?: (payload: import("./actionEngine").ActionCreatePayload) => Promise<{
        success: boolean;
        action?: import("./actionEngine").Action;
        error?: string;
      }>;
      actionEngineUpdate?: (
        id: string,
        patch: import("./actionEngine").ActionUpdatePayload
      ) => Promise<{
        success: boolean;
        action?: import("./actionEngine").Action;
        error?: string;
      }>;
      actionEngineDelete?: (id: string) => Promise<{ success: boolean; error?: string }>;
      actionEngineToggle?: (
        id: string,
        enabled: boolean
      ) => Promise<{
        success: boolean;
        action?: import("./actionEngine").Action;
        error?: string;
      }>;
      actionEngineExecute?: (
        id: string,
        runOptions?: { triggeredBy?: "manual" | "transcript"; triggerText?: string | null }
      ) => Promise<import("./actionEngine").ActionExecuteResult>;
      actionEngineMatch?: (transcript: string) => Promise<{
        success: boolean;
        matches?: import("./actionEngine").ActionMatchResult[];
        error?: string;
      }>;
      onActionEngineDictationMode?: (
        callback: (event: unknown, mode: string) => void
      ) => () => void;
      // Action run history
      actionEngineRunsList?: (limit?: number) => Promise<{
        success: boolean;
        runs?: import("./actionEngine").ActionRun[];
        error?: string;
      }>;
      actionEngineRunsClear?: () => Promise<{ success: boolean; error?: string }>;
      /** Delete oldest runs so that at most maxRuns records remain. 0 = unlimited (no-op). */
      actionEngineRunsPrune?: (
        maxRuns: number
      ) => Promise<{ success: boolean; pruned?: number; error?: string }>;
      /** Returns a sorted list of installed apps for the "Open application" action picker. */
      actionEngineListApps?: () => Promise<{
        success: boolean;
        apps?: Array<{ name: string; path: string }>;
        error?: string;
      }>;

      // CUDA binary download
      getCudaBinaryStatus?: () => Promise<{
        installed: boolean;
        path: string | null;
        platform: string;
        supported: boolean;
        forceCpu: boolean;
      }>;
      downloadCudaBinary?: () => Promise<{ success: boolean; error?: string }>;
      cancelCudaBinaryDownload?: () => Promise<{ success: boolean }>;
      setWhisperForceCpu?: (value: boolean) => Promise<{ success: boolean; error?: string }>;
      onCudaBinaryDownloadProgress?: (
        callback: (
          event: unknown,
          data: {
            progress?: number;
            percent?: number;
            phase?: string;
            downloadedBytes?: number;
            bytesDownloaded?: number;
            totalBytes?: number;
          }
        ) => void
      ) => () => void;
    };

    api?: {
      sendDebugLog: (message: string) => void;
    };
  }
}
