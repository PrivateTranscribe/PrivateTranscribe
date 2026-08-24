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

/** Progress for a Kokoro model download, aggregated across the model's files. */
export interface KokoroDownloadProgressData {
  type: string;
  model: string;
  percentage?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  error?: string;
}

export interface KokoroModelStatus {
  model: string;
  installed: boolean;
  /** Registry-relative paths that are absent or truncated. */
  missingFiles: string[];
  totalBytes: number;
  dir: string;
}

export interface KokoroEngineStatus {
  loaded: boolean;
  loading: boolean;
  coldStartMs: number;
  error: string | null;
}

export interface KokoroSynthResult {
  pcm: Float32Array;
  sampleRate: number;
  synthMs: number;
}

/**
 * Which agent answered a Converse turn. "mock" means the deterministic canned
 * reply — either asked for, or fallen back to after the live CLI returned an
 * API error. A mock run can never be mistaken for a live one.
 */
export type ConverseAgentMode = "live" | "mock";

export type ConverseSessionState = "idle" | "thinking" | "speaking" | "listening" | "stopped";

/** One entry of the Converse state log; `at` is a Date.now() timestamp. */
export interface ConverseTransition {
  state: ConverseSessionState;
  at: number;
  reason: string;
}

/** Renderer -> main playback report; the session's only evidence audio played. */
export interface ConversePlayerReport {
  gen: number;
  playing: boolean;
  playIndex: number;
  known: number;
  total: number | null;
  cached: number;
  drained: boolean;
  lastSynthMs: number | null;
  error: string | null;
}

export interface ConverseState {
  state: ConverseSessionState;
  running: boolean;
  stateForMs?: number;
  agentMode?: ConverseAgentMode;
  model?: string;
  /** Raw error text from the agent, kept verbatim (e.g. a rate-limit message). */
  lastError?: string | null;
  turnGen?: number;
  /** Project directory the session runs in; the key its session id is stored under. */
  cwd?: string;
  /** The `claude` session this conversation is in, once the CLI has named it. */
  sessionId?: string | null;
  /** The id passed to `--resume` at start, or null for a fresh conversation. */
  resumedFrom?: string | null;
  stateLog?: ConverseTransition[];
  player?: ConversePlayerReport | null;
  agent?: Record<string, unknown>;
  lastUtterance?: { text: string; at: number; gen: number } | null;
  lastResponse?: { text: string; sentences: string[]; at?: number } | null;
  lastInterrupt?: Record<string, unknown> | null;
  /** Whether the CLI's own permission questions can reach the user at all. */
  permissionRelay?: boolean;
  /** Every permission question the harness asked, with how each was answered. */
  permissionLog?: ConversePermissionEntry[];
}

/**
 * One permission question the `claude` process asked, as the relay recorded it.
 *
 * This log is the truth the Converse page renders from: an entry with
 * `answeredWith === null` is still waiting on the user, and everything else is
 * settled. The page never decides an outcome itself — not even when its own
 * countdown reaches zero.
 */
export interface ConversePermissionEntry {
  id: number;
  at: number;
  tool_name: string;
  input: unknown;
  tool_use_id: string | null;
  answeredWith: "allow" | "deny" | null;
  answeredAt: number | null;
  /** Who decided: the user, a standing answer, the deny timeout, or a stop. */
  answeredBy?: "user" | "auto" | "timeout" | "session-stopped" | null;
  /** When this question denies itself, absolute. The countdown reads this. */
  deadline?: number;
  timeoutMs?: number;
}

/** Outcome of copying the foreground app's selection. See selectionCapture.js. */
export interface SelectionCaptureResult {
  text: string;
  /**
   * `selection` - Ctrl+C actually produced new text.
   * `clipboard` - the copy produced nothing, so the pre-existing clipboard was
   *   used instead.
   * `none` - nothing to read.
   * `unsupported` - not Windows, or the capture worker is unavailable.
   */
  source: "selection" | "clipboard" | "none" | "unsupported";
  /** How long the worker waited for the trigger modifiers to be released. */
  waitedMs: number | null;
  /** Wall time of the whole capture, for the trigger-lag timing harness. */
  elapsedMs?: number;
  /** Raw worker reply, e.g. "OK waited=120ms" or "ERR timeout". */
  detail: string;
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

export interface FeedbackAttachmentPayload {
  name: string;
  type: string;
  size: number;
  dataUrl: string;
}

export interface FeedbackSubmitPayload {
  message: string;
  category?: "bug" | "confusing" | "feature" | "general";
  attachments?: FeedbackAttachmentPayload[];
  appVersion?: string;
  source?: string;
}

export interface FeedbackSubmitResult {
  success: boolean;
  error?: string;
  code?: string;
}

export interface TranscriptionSettingsBroadcast {
  useLocalWhisper?: string;
  whisperModel?: string;
  localTranscriptionProvider?: LocalTranscriptionProvider;
  whisperForceCpu?: string;
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

export interface OverlayState {
  /** "shown" = visible, "snoozed" = temporarily hidden, "off" = persistently disabled */
  mode: "shown" | "snoozed" | "off";
  /** Epoch ms when a snooze auto-restores the overlay; null unless mode is "snoozed" */
  snoozeUntil: number | null;
}

export type ControlPanelPage =
  | "home"
  | "history"
  | "transcribe"
  | "dictionary"
  | "read-aloud"
  | "ai-enhancement"
  | "correction-memory"
  | "action-engine"
  | "settings";

export type ControlPanelSettingsTab =
  | "general"
  | "preferences"
  | "transcription"
  | "permissions"
  | "pro"
  | "help"
  | "developer";

export interface ControlPanelDestination {
  page: ControlPanelPage;
  settingsTab?: ControlPanelSettingsTab;
}

/** A voice app currently streaming from the microphone, i.e. actually in a call. */
export interface VoiceCallApp {
  id: string;
  label: string;
  pid: number;
  pushToMute: boolean;
}

declare global {
  interface Window {
    electronAPI: {
      // Basic window operations
      pasteText: (text: string) => Promise<{
        delivered: boolean;
        dispatched?: boolean;
        fallback?: "clipboard";
        method?: string;
      }>;
      hideWindow: () => Promise<void>;
      showDictationPanel: () => Promise<void>;
      getOverlayState?: () => Promise<OverlayState>;
      setOverlayMode?: (mode: "shown" | "off") => Promise<OverlayState>;
      snoozeOverlay?: (durationMs: number) => Promise<OverlayState>;
      migrateLegacyOverlayDisabled?: (disabled: boolean) => Promise<{ migrated: boolean }>;
      onOverlayStateChanged?: (callback: (state: OverlayState) => void) => (() => void) | void;
      setOverlaySnapToTaskbar?: (
        enabled: boolean
      ) => Promise<{ success: boolean; enabled: boolean }>;
      getOverlaySnapToTaskbar?: () => Promise<{ enabled: boolean }>;
      notifyDictationOverlayReady?: () => Promise<{ success: boolean }>;
      openControlPanel?: (destination?: ControlPanelDestination) => Promise<{ success: boolean }>;
      onControlPanelNavigate?: (
        callback: (destination: ControlPanelDestination) => void
      ) => (() => void) | void;
      onToggleDictation: (callback: () => void) => (() => void) | void;
      onStartDictation?: (callback: () => void) => (() => void) | void;
      onStopDictation?: (callback: () => void) => (() => void) | void;
      onHybridDictationKeyDown?: (callback: () => void) => (() => void) | void;
      onHybridDictationKeyUp?: (callback: () => void) => (() => void) | void;
      onWindowDragReset?: (callback: (data?: { reason?: string }) => void) => (() => void) | void;
      /** Fires on OS power resume / screen unlock only (not ordinary window show). */
      onSystemResumed?: (callback: (data?: { reason?: string }) => void) => (() => void) | void;

      // Database operations
      saveTranscription: (
        text: string,
        durationSeconds?: number | null,
        options?: SaveTranscriptionOptions
      ) => Promise<{ id: number; success: boolean }>;
      recordTranscriptionActivity?: (
        text: string,
        durationSeconds?: number | null
      ) => Promise<{ success: boolean }>;
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
      confirmCorrection: (source: string, target: string) => Promise<{ success: boolean }>;
      deleteCorrection: (source: string) => Promise<{ success: boolean }>;

      // Stats operations
      getStats: () => Promise<AggregateStats>;
      resetStats: () => Promise<{ success: boolean }>;
      /** Returns one representative UTC timestamp for each local dictation day. */
      getStreakDates: () => Promise<string[]>;

      // Optional, consent-based analytics. Properties never include audio or transcript text.
      analyticsNeedsConsent?: () => Promise<boolean>;
      analyticsGetConsent?: () => Promise<"granted" | "denied" | null>;
      analyticsSetConsent?: (granted: boolean) => Promise<{ saved?: boolean } | void>;
      analyticsTrack?: (
        event: string,
        properties?: Record<string, string | number | boolean>
      ) => Promise<{ sent: boolean; reason?: string }>;

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
      submitFeedback?: (payload: FeedbackSubmitPayload) => Promise<FeedbackSubmitResult>;
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
      transcribeFileV2: (audioBlob: Blob | ArrayBuffer, options?: any) => Promise<any>;
      cancelFileTranscription: (
        jobId?: string | null
      ) => Promise<{ success: boolean; cancelled: boolean; jobs: number }>;
      onFileTranscriptionProgress: (
        callback: (
          event: any,
          data: {
            stage: string;
            percentage: number;
            chunksTotal?: number;
            chunksCompleted?: number;
          }
        ) => void
      ) => (() => void) | void;
      checkDiarizationModelStatus: () => Promise<any>;
      downloadDiarizationModels: () => Promise<any>;
      onDiarizationDownloadProgress: (
        callback: (event: any, data: any) => void
      ) => (() => void) | void;
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

      // Read Aloud (Kokoro TTS) — engine runs in the main process, renderer plays PCM
      readAloudCheckModelStatus: (modelId?: string) => Promise<KokoroModelStatus>;
      readAloudDownloadModel: (modelId?: string) => Promise<{
        model: string;
        downloaded: boolean;
        path: string;
        success: boolean;
      }>;
      onReadAloudDownloadProgress: (
        callback: (event: any, data: KokoroDownloadProgressData) => void
      ) => (() => void) | void;
      readAloudCancelDownload: () => Promise<{
        success: boolean;
        message?: string;
        error?: string;
      }>;
      readAloudDeleteModel: (modelId?: string) => Promise<{
        model: string;
        deleted: boolean;
        freed_bytes?: number;
        freed_mb?: number;
        error?: string;
        success: boolean;
      }>;
      readAloudLoadEngine: (modelId?: string) => Promise<KokoroEngineStatus>;
      readAloudEngineStatus: () => Promise<KokoroEngineStatus>;
      readAloudSplit: (text: string) => Promise<string[]>;
      readAloudSynth: (options: {
        text: string;
        voice?: string;
        speed?: number;
      }) => Promise<KokoroSynthResult>;
      /**
       * Copy the foreground app's selection and push it to the overlay to speak.
       * The result describes the capture itself; the speaking happens over the
       * `readaloud-speak` event.
       */
      readAloudReadSelection: () => Promise<SelectionCaptureResult>;
      /**
       * Real main-process decision on whether `text` is confidently
       * non-English and should be blocked from synthesis. Exists so tests can
       * exercise the actual guard (dynamic `tinyld` import and all) without
       * desktop selection capture.
       */
      readAloudLanguageCheck: (text: string) => Promise<{
        block: boolean;
        language?: string;
        languageName?: string;
      }>;
      /**
       * Round-trip cost of the copy worker's line protocol. Injects no
       * keystrokes and never touches the clipboard; exists for the
       * trigger-lag timing harness.
       */
      readAloudCaptureProbe: () => Promise<{
        ok: boolean;
        rttMs: number | null;
        detail: string;
      }>;
      /**
       * Register or unregister the Read Aloud global shortcut to match the
       * renderer's saved settings. The main process refuses to register while
       * the voice model is missing, and reports that as `reason`.
       */
      readAloudSyncHotkey: (settings: { enabled: boolean; hotkey: string }) => Promise<{
        registered: boolean;
        hotkey: string;
        reason?: string;
      }>;
      /**
       * Report whether a read is currently on screen. While it is, the main
       * process holds the transient playback shortcuts
       * (Ctrl+Alt+Shift+Space / Left / Right); when it is not, nothing is bound.
       */
      readAloudSetPlaybackActive: (active: boolean) => Promise<{
        active: boolean;
        registered: string[];
        reason?: string;
      }>;
      /**
       * Text captured from the foreground app, for the overlay to speak.
       * `source` mirrors SelectionCaptureResult: a `clipboard` read is the
       * pre-existing clipboard rather than the selection, and the overlay says
       * so instead of passing it off as what the user highlighted.
       */
      onReadAloudSpeak: (
        callback: (
          event: any,
          data: { text: string; source?: SelectionCaptureResult["source"] }
        ) => void
      ) => (() => void) | void;
      /**
       * Sent instead of `readaloud-speak` when a capture produced no text, so
       * the hotkey always answers with something the user can see.
       */
      onReadAloudNotice: (
        callback: (event: any, data: { reason: "empty-selection" | "unsupported" }) => void
      ) => (() => void) | void;
      /**
       * One press of a transient playback shortcut, forwarded from the main
       * process because the overlay is where the player lives.
       */
      onReadAloudControl: (
        callback: (event: any, data: { op: "toggle" | "back" | "forward" }) => void
      ) => (() => void) | void;
      /** True only when PRIVATETRANSCRIBE_DIAG_ENABLE_READALOUD_TEST=1 at launch. */
      readAloudTestEnabled: boolean;

      // Converse (voice loop) — one persistent `claude` process per session,
      // its reply spoken sentence by sentence through the Read Aloud engine.
      /**
       * Start a session. `mock: true` replaces the CLI with a deterministic
       * canned reply; the mode is reported back as `agentMode` so a run can
       * never be mistaken for a live one.
       */
      converseStart: (options?: {
        model?: string;
        cwd?: string;
        mock?: boolean;
        /**
         * Continue the last `claude` session recorded for this cwd instead of
         * starting a fresh conversation. The id survives an app restart; the
         * state reports it back as `resumedFrom`.
         */
        resume?: boolean;
        /**
         * Relay the harness's own permission questions to the app. The app
         * adds no rules; unanswered questions deny themselves.
         */
        permissionRelay?: boolean;
        /**
         * Also pass `--strict-mcp-config`, which makes the CLI ignore the
         * user's own project MCP servers. Off for real sessions; only a
         * hermetic test turns it on.
         */
        strictMcpConfig?: boolean;
        /** Path to a `--settings` file for the spawned CLI (tests only). */
        settingsFile?: string | null;
      }) => Promise<ConverseState>;
      /** Inject a user turn as text. The microphone path will call this too. */
      converseSendUtterance: (text: string) => Promise<{
        accepted: boolean;
        reason?: string;
        state: string;
        turnGen?: number;
        agentMode?: ConverseAgentMode;
      }>;
      converseGetState: () => Promise<ConverseState>;
      converseInterrupt: (reason?: string) => Promise<{
        turnGen: number;
        from: string;
        state: string;
      }>;
      converseStop: () => Promise<ConverseState>;
      conversePermissionAutoAnswer: (
        behavior: "allow" | "deny" | null
      ) => Promise<{ armed: "allow" | "deny" | null; reason?: string }>;
      conversePermissionAnswer: (
        id: number,
        behavior: "allow" | "deny"
      ) => Promise<{ answered: boolean; reason?: string }>;
      onConversePermissionRequest: (
        callback: (
          event: any,
          data: {
            id: number;
            tool_name: string;
            input: unknown;
            at: number;
            deadline?: number;
            timeoutMs?: number;
          }
        ) => void
      ) => (() => void) | void;
      onConverseSentence: (
        callback: (event: any, data: { gen: number; index: number; text: string }) => void
      ) => (() => void) | void;
      onConverseTurnEnd: (
        callback: (event: any, data: { gen: number; total: number }) => void
      ) => (() => void) | void;
      onConverseInterrupt: (
        callback: (event: any, data: { gen: number; reason: string }) => void
      ) => (() => void) | void;
      converseReportPlayerState: (state: ConversePlayerReport) => void;

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

      // Window control operations
      windowMinimize: () => Promise<void>;
      windowMaximize: () => Promise<void>;
      windowClose: () => Promise<void>;
      windowIsMaximized: () => Promise<boolean>;
      getPlatform: () => string;
      startWindowDrag: () => Promise<void>;
      stopWindowDrag: () => Promise<void>;
      setMainWindowInteractivity: (interactive: boolean) => Promise<void>;
      setMainWindowInteractiveRegions?: (
        source: string,
        regions: Array<{ x: number; y: number; width: number; height: number }>
      ) => Promise<{ success: boolean }>;
      refreshMainWindowInteractivity: () => Promise<void>;

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

      // Voice-call mute - holds a voice app's push-to-mute key while dictating
      voiceMuteStart?: (options: {
        key: string;
      }) => Promise<{ muted: boolean; reason?: string; apps?: VoiceCallApp[] }>;
      voiceMuteStop?: () => Promise<{ released: boolean }>;
      voiceMuteStatus?: () => Promise<{
        supported: boolean;
        activeApps: VoiceCallApp[];
        muted: boolean;
      }>;
      voiceMuteTest?: (options: {
        key: string;
        holdMs?: number;
      }) => Promise<{ ok: boolean; reason?: string }>;

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
      getRuntimeVersions?: () => {
        electron?: string;
        chrome?: string;
        node?: string;
      };
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
      notifyActivationModeChanged?: (mode: "tap" | "push" | "tapHold") => void;
      notifyHotkeyChanged?: (hotkey: string) => void;
      notifyTranscriptionSettingsChanged?: (settings: TranscriptionSettingsBroadcast) => void;
      onTranscriptionSettingsChanged?: (
        callback: (settings: TranscriptionSettingsBroadcast) => void
      ) => (() => void) | void;

      // Auto-start at login
      getAutoStartEnabled?: () => Promise<boolean>;
      setAutoStartEnabled?: (
        enabled: boolean
      ) => Promise<{ success: boolean; enabled?: boolean; error?: string }>;
      getAutoStartLaunchMode?: () => Promise<"tray" | "minimized" | "window">;
      setAutoStartLaunchMode?: (mode: "tray" | "minimized" | "window") => Promise<{
        success: boolean;
        launchMode?: "tray" | "minimized" | "window";
        error?: string;
      }>;

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
        version: string | null;
        upToDate: boolean;
        expectedVersion: string;
        /** Newest engine on the update CDN; null when offline/unknown. Installs stay pinned to expectedVersion. */
        latestAvailableVersion?: string | null;
        forceCpu: boolean;
        engineStatus?: {
          desiredMode?: "cpu" | "gpu";
          effectiveEngine?: "cuda" | "cpu" | "unknown" | "stopped";
          fallback?: {
            active?: boolean;
            reason?: string | null;
            since?: number | null;
            failureCount?: number;
            nextRetryAt?: number | null;
            diagnostic?: unknown;
          };
          transition?: "starting" | "transcribing" | "idle" | "stopped";
          activeTranscriptions?: number;
          stoppedDueToIdle?: boolean;
        } | null;
        cudaAutoUpdateFailed?: boolean;
      }>;
      downloadCudaBinary?: () => Promise<{ success: boolean; error?: string }>;
      cancelCudaBinaryDownload?: () => Promise<{ success: boolean }>;
      setWhisperForceCpu?: (value: boolean) => Promise<{ success: boolean; error?: string }>;
      /** `0` means auto. Resolved value comes back so the UI can show it. */
      setWhisperThreads?: (
        value: number
      ) => Promise<{ success: boolean; resolved?: number; error?: string }>;
      getCpuThreadInfo?: () => Promise<{
        success: boolean;
        physicalCores: number;
        logicalCores: number;
        autoThreads: number;
        maxAutoThreads: number;
      }>;
      /** Fired when the GPU→CPU transcription fallback engages (active: true) or recovers. */
      onWhisperEngineFallbackChanged?: (
        callback: (
          event: unknown,
          data: {
            active?: boolean;
            recovered?: boolean;
            reason?: string;
            kind?: string;
            message?: string;
            failureCount?: number;
            nextRetryAt?: number | null;
          }
        ) => void
      ) => () => void;
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
