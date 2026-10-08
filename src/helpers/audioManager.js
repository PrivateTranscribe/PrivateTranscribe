import ReasoningService from "../services/ReasoningService";
import { API_ENDPOINTS, buildApiUrl, normalizeBaseUrl } from "../config/constants";
import logger from "../utils/logger";
import { resolveMicWarmWindowMs } from "../utils/micWarmWindow";
import { buildMicrophoneConstraints, describeMicrophoneSelection } from "../utils/audioDeviceUtils";
import { isSecureEndpoint } from "../utils/urlUtils";
import { resolveTranscriptionLanguage } from "../utils/languageCompat";
import { readSpokenLanguages } from "../utils/spokenLanguages";
import { repairSplitDictionaryTerms } from "../utils/transcriptionTextRepair";
import { assessTranscriptionCompleteness } from "../utils/transcriptionCompleteness";
import { getSharedAudioContext } from "../utils/sharedAudioContext";
import { frameRmsLevels, summarizeSpeechLevels } from "../utils/speechPresence";
import { classifyNonSpeechArtifact } from "../utils/nonSpeechArtifact";
import { buildDictionaryPrompt } from "../utils/dictionaryPrompt";
import { areExperimentalFeaturesEnabled } from "../utils/experimentalFeatures";
import {
  getContext,
  isSmartContextEnabled,
  isFileIdentifiersEnabled,
  buildWhisperContextHint,
  buildFileIdentifierHint,
} from "./contextPipeline";

const normalizePunctuationSpacing = (text) =>
  String(text || "")
    .replace(/\s+([,.;:!?%])/g, "$1")
    .replace(/\b([A-Za-z]+)\s+(['’])\s*(m|re|ve|ll|d|s|t)\b/gi, "$1$2$3")
    .replace(/([([{])\s+/g, "$1")
    .replace(/\s+([)\]}])/g, "$1");

const SHORT_CLIP_DURATION_SECONDS = 2.5;
const REASONING_CACHE_TTL = 30000; // 30 seconds
const RECORDER_TIMESLICE_MS = 30000;
const RECORDER_STOP_TIMEOUT_MS = 30000;
const RECORDER_FINAL_DATA_GRACE_MS = 250;
const MIN_DICTATION_DURATION_MS = 500;
const LONG_SESSION_PROMOTION_MS = 5 * 60 * 1000;
const LONG_SESSION_CHUNK_TARGET_MS = RECORDER_TIMESLICE_MS;
const LONG_SESSION_SEGMENT_MS = 60 * 1000;
// Segments are transcribed independently, so a boundary that lands mid-sentence
// leaves Whisper decoding an utterance that never finishes. It reacts by
// inventing a plausible ending. Once the target length is reached, wait for a
// real pause in speech before rotating, and only cut mid-speech if the speaker
// never pauses before the hard cap.
const LONG_SESSION_SEGMENT_MAX_MS = 90 * 1000;
const LONG_SESSION_SEGMENT_PAUSE_POLL_MS = 100;
const LONG_SESSION_SEGMENT_PAUSE_HOLD_MS = 300;
const LONG_SESSION_SEGMENT_PAUSE_RMS = 0.015;
// How often the microphone level is sampled across a whole dictation, so the
// recording can be judged for speech before it is handed to any engine.
const SPEECH_LEVEL_POLL_MS = 50;
// Rate a recording is decoded at when it has to be measured after the fact.
// Plenty for telling speech from silence, and a third of the work of 48 kHz.
const RECORDED_LEVEL_SAMPLE_RATE = 16000;
const LONG_SESSION_CHUNK_MAX_ATTEMPTS = 3;
// Retrying a failed chunk instantly just re-runs it against whatever broke it.
// A short pause lets a busy or restarting whisper-server come back first.
const LONG_SESSION_CHUNK_RETRY_BACKOFF_MS = 500;

// A missing section is invisible in pasted prose: the sentences on either side
// join up and read as one continuous thought. Mark the gap so the speaker can
// see where their words went instead of discovering the hole later.
export const MISSING_SECTION_MARKER = "[... missing section ...]";

const isTranscriptionTextDebugEnabled = () => {
  try {
    if (typeof window === "undefined" || !window.localStorage) return false;
    const value = window.localStorage.getItem("debugTranscriptionText");
    return value === "on" || value === "true" || value === "1";
  } catch {
    return false;
  }
};

// Keep both ends of a long transcript. Hallucinated endings are the artifact
// this trace exists to diagnose, and a head-only preview hides them.
const previewText = (value, limit = 500) => {
  const text = String(value || "");
  if (text.length <= limit) return text;

  const head = Math.ceil(limit / 2);
  const tail = limit - head;
  return `${text.slice(0, head)}...[${text.length - limit} chars omitted]...${text.slice(-tail)}`;
};

const emitTranscriptionTextTrace = (stage, meta = {}) => {
  if (!isTranscriptionTextDebugEnabled()) return;

  const safeMeta = {
    ...meta,
    raw: meta.raw !== undefined ? previewText(meta.raw) : undefined,
    normalized: meta.normalized !== undefined ? previewText(meta.normalized) : undefined,
    final: meta.final !== undefined ? previewText(meta.final) : undefined,
  };

  // This intentionally logs transcript text only when explicitly enabled by the user.
  // It appears in Electron DevTools and is also routed through the app logger.
  console.info(`[transcription-text] ${stage}`, safeMeta);
  logger.info(`TRANSCRIPTION_TEXT_${stage}`, safeMeta, "transcription");
};

const PLACEHOLDER_KEYS = {
  openai: "your_openai_api_key_here",
  groq: "your_groq_api_key_here",
};

const LONG_LOCAL_WHISPER_HINT =
  "For long recordings, try Whisper Turbo/Medium or CPU only if Large exhausts GPU memory.";

const localWhisperSupportsTranslation = (model) => model !== "turbo";

const shouldTranslateLocalWhisperToEnglish = ({ translateToEnglish, resolvedLanguage, model }) => {
  if (translateToEnglish !== "on") return false;
  if (!localWhisperSupportsTranslation(model)) return false;
  // Only translate when the user explicitly selected a non-English speech language.
  // If the language picker is Auto/empty, a stale hidden translate toggle can otherwise
  // turn Danish speech into English and look like random model behavior.
  return !!resolvedLanguage && resolvedLanguage !== "en";
};

const formatLocalWhisperFailure = (message) => {
  const rawMessage = (message || "Unknown error").replace(/^Local Whisper failed:\s*/i, "");
  const normalized = rawMessage.toLowerCase();

  if (normalized.includes("request timed out") || normalized.includes("timed out")) {
    return `Local Whisper took too long to finish this file. PrivateTranscribe now processes long files in smaller chunks, but this recording/model combination may still be too slow on this machine. ${LONG_LOCAL_WHISPER_HINT}`;
  }

  if (
    normalized.includes("out of memory") ||
    normalized.includes("bad_alloc") ||
    normalized.includes("cannot allocate") ||
    normalized.includes("allocation failed") ||
    normalized.includes("exit code 137") ||
    normalized.includes("sigkill") ||
    normalized.includes("killed")
  ) {
    return `Local Whisper ran out of memory while transcribing this file. ${LONG_LOCAL_WHISPER_HINT}`;
  }

  if (normalized.includes("whisper-server returned status 500")) {
    return `Local Whisper crashed while processing this file. This is common with very long recordings on Whisper Large when GPU/VRAM is tight. ${LONG_LOCAL_WHISPER_HINT}`;
  }

  return `Local Whisper failed: ${rawMessage}`;
};

// Toast buttons useAudioRecording knows how to render for a failed dictation.
export const TRANSCRIPTION_TOAST_ACTIONS = Object.freeze({
  SWITCH_TO_WHISPER: "switch-to-whisper",
  OPEN_SPEECH_MODEL_SETTINGS: "open-speech-model-settings",
});

/** An error whose toast replaces the generic "Transcription failed" one. */
const createToastError = (message, toast) => Object.assign(new Error(message), { toast });

/**
 * One shape for a Parakeet failure, whether the IPC handler returned
 * `{ success: false, error }` or rejected. A rejection loses the error's code
 * on its way through ipcRenderer.invoke, so only its message survives.
 */
const describeParakeetFailure = (failure) => {
  const rawMessage = failure?.message || failure?.error || "Parakeet transcription failed";
  const message = String(rawMessage).replace(
    /^Error invoking remote method '[^']+':\s*(?:\w*Error:\s*)?/,
    ""
  );
  return {
    code: failure?.code || (failure?.success === false ? failure.error : null) || null,
    message,
    cancelled: failure?.name === "AbortError" || failure?.cancelled === true,
  };
};

const isValidApiKey = (key, provider = "openai") => {
  if (!key || key.trim() === "") return false;
  const placeholder = PLACEHOLDER_KEYS[provider] || PLACEHOLDER_KEYS.openai;
  return key !== placeholder;
};

const toIpcSafeArrayBuffer = (arrayBuffer) => {
  const source = new Uint8Array(arrayBuffer);
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy.buffer;
};

const MIME_EXTENSION_MAP = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
  "video/x-m4v": "m4v",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/webm": "webm",
  "video/x-msvideo": "avi",
};

const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  "wav",
  "mp3",
  "m4a",
  "ogg",
  "flac",
  "webm",
  "mp4",
  "m4v",
  "mov",
  "mkv",
  "avi",
]);

const getExtensionFromFileName = (fileName) => {
  if (!fileName || typeof fileName !== "string") return "";
  const parts = fileName.toLowerCase().split(".");
  return parts.length > 1 ? parts.pop() || "" : "";
};

const getExtensionFromMimeType = (mimeType) => {
  if (!mimeType || typeof mimeType !== "string") return "";
  return MIME_EXTENSION_MAP[mimeType.toLowerCase()] || "";
};

const resolveUploadExtension = (originalFileName, mimeType, fallback = "webm") => {
  const fromName = getExtensionFromFileName(originalFileName);
  if (ALLOWED_UPLOAD_EXTENSIONS.has(fromName)) {
    return fromName;
  }

  const fromMime = getExtensionFromMimeType(mimeType);
  if (ALLOWED_UPLOAD_EXTENSIONS.has(fromMime)) {
    return fromMime;
  }

  return fallback;
};

const resolveUploadFileName = (originalFileName, mimeType) => {
  const extension = resolveUploadExtension(originalFileName, mimeType);
  const baseName =
    originalFileName && typeof originalFileName === "string"
      ? originalFileName
          .trim()
          .replace(/[\\/:*?"<>|]/g, "_")
          .replace(/\.[^./\\]+$/, "")
      : "";

  const safeBase = baseName || "upload";
  return `${safeBase}.${extension}`;
};

class AudioManager {
  constructor() {
    this.mediaRecorder = null;
    this.recordingStream = null;
    this.audioChunks = [];
    this.isRecording = false;
    this.isProcessing = false;
    this.isStartingRecording = false;
    this.isStoppingRecording = false;
    this.onStateChange = null;
    this.onError = null;
    this.onTranscriptionComplete = null;
    this.cachedApiKey = null;
    this.cachedApiKeyProvider = null;
    this.cachedTranscriptionEndpoint = null;
    this.cachedEndpointProvider = null;
    this.cachedEndpointBaseUrl = null;
    this.transcriptionSettingsSnapshot = null;
    this.transcriptionSettingsChangedCleanup = null;
    this.recordingStartTime = null;
    this.recordingMimeType = "audio/webm";
    this.recordingSessionCounter = 0;
    this.activeRecordingSessionId = null;
    this.recordingStopTimeoutId = null;
    this.recordingChunkDurationsMs = [];
    this.lastRecorderDataAt = null;
    this.longSessionPromotionMs = LONG_SESSION_PROMOTION_MS;
    this.longSessionChunkTargetMs = LONG_SESSION_CHUNK_TARGET_MS;
    this.longSessionChunkRetryBackoffMs = LONG_SESSION_CHUNK_RETRY_BACKOFF_MS;
    this.longSession = this.createLongSessionState();
    this.longSessionSegment = null;
    this.longSessionPromotionUnavailable = false;
    this.segmentLevelAnalyser = null;
    this.speechLevelMonitor = null;
    this.pendingStopAfterStart = false;
    this.pendingCancelAfterStart = false;
    this.discardCurrentRecording = false;
    this.reasoningAvailabilityCache = { value: false, expiresAt: 0 };
    this.cachedReasoningPreference = null;
    this._cachedAudioInputs = null;
    this._pooledStream = null;
    this._pooledStreamReleaseTimer = null;
    this._pooledStreamConstraintsKey = null;
    this.processingGeneration = 0;
    this.activeTranscriptionAbortController = null;
    this.activeTranscriptionGeneration = 0;
    this._cachedSmartContext = null;
    this._checkBetaFeatureAccess = null;
    this._deviceChangeHandler = null;

    // Pre-warm device cache and keep it fresh. `typeof` guard: under Vitest on
    // Node 20 there is no global navigator at all, and a bare reference throws.
    if (typeof navigator !== "undefined" && navigator.mediaDevices) {
      this._warmDeviceCache();
      this._deviceChangeHandler = () => {
        this._warmDeviceCache();
        this._clearPooledStream();
      };
      navigator.mediaDevices.addEventListener("devicechange", this._deviceChangeHandler);
    }

    // After system sleep/wake or screen unlock, Windows often invalidates the
    // audio capture device while the pooled MediaStream's tracks still report
    // readyState "live". Reusing that zombie stream records pure silence and
    // freezes the level bars. Drop the warm stream so the next dictation
    // re-acquires a fresh one via getUserMedia.
    this._systemResumedCleanup =
      window.electronAPI?.onSystemResumed?.(() => {
        this.handleSystemResumed();
      }) || null;

    if (window.electronAPI?.onTranscriptionSettingsChanged) {
      this.transcriptionSettingsChangedCleanup =
        window.electronAPI.onTranscriptionSettingsChanged((settings = {}) => {
          if (!settings || typeof settings !== "object") {
            this.transcriptionSettingsSnapshot = null;
          } else {
            this.transcriptionSettingsSnapshot = {
              ...(this.transcriptionSettingsSnapshot || {}),
              ...settings,
            };
          }
          this.invalidateTranscriptionRuntimeCaches();
        }) || null;
    }
  }

  handleSystemResumed() {
    this._warmDeviceCache();

    // Never stop tracks under an active recorder — a recording that spanned
    // sleep is finalized through its own stop/watchdog path.
    if (this.isRecording || this.isStartingRecording || this.isStoppingRecording) {
      return;
    }

    this._clearPooledStream();
  }

  async _warmDeviceCache() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this._cachedAudioInputs = devices.filter((d) => d.kind === "audioinput");
    } catch {
      this._cachedAudioInputs = null;
    }
  }

  _constraintsKey(constraints) {
    const deviceId =
      constraints?.audio?.deviceId?.exact || constraints?.audio?.deviceId || "default";
    return String(deviceId);
  }

  async _acquireStream(constraints) {
    const key = this._constraintsKey(constraints);
    // A muted track means the OS stopped delivering frames (dead device after
    // sleep/wake, exclusive-mode grab, ...). readyState alone stays "live" in
    // those cases, so treat muted as stale too.
    if (
      this._pooledStream &&
      this._pooledStreamConstraintsKey === key &&
      this._pooledStream.getTracks().every((t) => t.readyState === "live" && !t.muted)
    ) {
      if (this._pooledStreamReleaseTimer) {
        clearTimeout(this._pooledStreamReleaseTimer);
        this._pooledStreamReleaseTimer = null;
      }
      return this._pooledStream;
    }
    // Pool miss or stale — tear down old pooled stream and acquire fresh
    this._clearPooledStream();
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this._pooledStream = stream;
    this._pooledStreamConstraintsKey = key;
    return stream;
  }

  _scheduleStreamRelease() {
    if (this._pooledStreamReleaseTimer) {
      clearTimeout(this._pooledStreamReleaseTimer);
      this._pooledStreamReleaseTimer = null;
    }
    // Keep the mic device open between dictations so a repeat hotkey press reuses the warm
    // stream instead of paying the getUserMedia cold-start cost (the "slow after idle" lag).
    // User-configurable via the "Keep microphone ready" setting; 0 = keep warm indefinitely.
    const windowMs = resolveMicWarmWindowMs(
      typeof localStorage !== "undefined" ? localStorage.getItem("micWarmWindowSeconds") : null
    );
    if (windowMs <= 0) {
      return;
    }
    this._pooledStreamReleaseTimer = setTimeout(() => {
      this._clearPooledStream();
    }, windowMs);
  }

  _clearPooledStream() {
    if (this._pooledStreamReleaseTimer) {
      clearTimeout(this._pooledStreamReleaseTimer);
      this._pooledStreamReleaseTimer = null;
    }
    if (this._pooledStream) {
      try {
        this._pooledStream.getTracks().forEach((t) => t.stop());
      } catch {
        // ignore cleanup errors
      }
      this._pooledStream = null;
    }
    this._pooledStreamConstraintsKey = null;
  }

  getCustomDictionaryPrompt() {
    try {
      const raw = localStorage.getItem("customDictionary");
      const words = [];
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) words.push(...parsed);
      }
      // Also include high-confidence correction targets as prompt hints
      // so whisper is more likely to recognize them
      // (correction memory is async/IPC, so we use a cached version if available)
      if (this._cachedCorrectionHints && this._cachedCorrectionHints.length > 0) {
        words.push(...this._cachedCorrectionHints);
      }
      return buildDictionaryPrompt(words);
    } catch {
      // ignore parse errors
    }
    return null;
  }

  /**
   * Cache correction memory targets for use in whisper prompt hints.
   * Called before transcription to avoid async IPC in the prompt builder.
   */
  async refreshCorrectionHints() {
    try {
      const corrections = await globalThis.electronAPI?.getCorrectionMemory?.(200);
      if (Array.isArray(corrections)) {
        // Prompt hints can influence transcription, so require explicit approval here too.
        this._cachedCorrectionHints = corrections
          .filter((r) => r?.target && r?.confirmed)
          .map((r) => r.target);
      }
    } catch {
      // ignore
    }
  }

  setCallbacks({ onStateChange, onError, onTranscriptionComplete, onNoAudioDetected }) {
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.onTranscriptionComplete = onTranscriptionComplete;
    // Main sends Whisper's silence as an IPC event; Parakeet's arrives in its result.
    this.onNoAudioDetected = onNoAudioDetected;
  }

  emitStateChange() {
    const isFinalizingRecording = this.isRecording && this.isStoppingRecording;
    this.onStateChange?.({
      // Stop listening in the UI as soon as the user releases the hotkey. The
      // recorder may still need a brief grace period to flush its final data,
      // but leaving the overlay in its recording state makes the meter look
      // frozen if the MediaRecorder stop event is delayed or never arrives.
      isRecording: this.isRecording && !isFinalizingRecording,
      isProcessing: this.isProcessing || (isFinalizingRecording && !this.discardCurrentRecording),
      longSession: this.getLongSessionSnapshot(),
    });
  }

  createLongSessionState() {
    return {
      active: false,
      cancelled: false,
      queue: [],
      results: new Map(),
      telemetry: new Map(),
      performanceTimingComplete: true,
      errors: [],
      processing: false,
      processingPromise: null,
      sessionId: 0,
      nextChunkIndex: 0,
      queuedChunks: 0,
      completedChunks: 0,
      recordedSeconds: 0,
      transcribedSeconds: 0,
      promotedAt: null,
      // Set once, from the first segment that comes back with real speech, and
      // then sent with every later segment of this recording. Scoped to the
      // session on purpose: it dies with resetLongSessionState(), so switching
      // language between recordings still works without touching a setting.
      detectedLanguage: null,
    };
  }

  recordLongSessionChunkTelemetry(state, item, transcription) {
    if (!state || !item || !transcription) {
      return;
    }

    const timings = transcription.result?.timings;
    // Inference time when the engine reports it, so a cold start's model load
    // does not get counted as time spent transcribing.
    const processingDurationMs = Number.isFinite(timings?.transcriptionInferenceDurationMs)
      ? timings.transcriptionInferenceDurationMs
      : timings?.transcriptionProcessingDurationMs;
    const audioDurationMs = item.durationMs;
    const hasPairedTiming =
      Number.isFinite(processingDurationMs) &&
      processingDurationMs > 0 &&
      Number.isFinite(audioDurationMs) &&
      audioDurationMs > 0 &&
      item.attempts === 1;

    if (!hasPairedTiming) {
      state.performanceTimingComplete = false;
    }

    state.telemetry.set(item.index, {
      activeModel: transcription.activeModel || "unknown",
      computeMode: transcription.computeMode || "unknown",
      audioDurationMs: hasPairedTiming ? audioDurationMs : null,
      processingDurationMs: hasPairedTiming ? processingDurationMs : null,
    });
  }

  /**
   * Returns only telemetry. The dictation's own durationSeconds stays the
   * recorded wall clock, because that is what the history and the words-per-
   * minute stats are counted against; the summed chunk audio below exists so
   * the speed metric divides by the audio the model was actually handed.
   */
  summarizeLongSessionTelemetry(state) {
    const entries = [...state.telemetry.values()];
    const models = new Set(entries.map((entry) => entry.activeModel).filter(Boolean));
    const computeModes = new Set(entries.map((entry) => entry.computeMode).filter(Boolean));
    const activeModel = models.size === 1 ? [...models][0] : models.size > 1 ? "mixed" : "unknown";
    const computeMode =
      computeModes.size === 1 ? [...computeModes][0] : computeModes.size > 1 ? "mixed" : "unknown";
    const hasCompleteTiming =
      state.performanceTimingComplete &&
      entries.length === state.completedChunks &&
      entries.length > 0 &&
      entries.every(
        (entry) =>
          Number.isFinite(entry.audioDurationMs) &&
          entry.audioDurationMs > 0 &&
          Number.isFinite(entry.processingDurationMs) &&
          entry.processingDurationMs > 0
      );

    if (!hasCompleteTiming) {
      return { activeModel, computeMode };
    }

    const audioDurationMs = entries.reduce((sum, entry) => sum + entry.audioDurationMs, 0);
    const processingDurationMs = entries.reduce(
      (sum, entry) => sum + entry.processingDurationMs,
      0
    );
    return {
      activeModel,
      computeMode,
      transcriptionAudioDurationSeconds: audioDurationMs / 1000,
      transcriptionProcessingDurationMs: processingDurationMs,
    };
  }

  getLongSessionSnapshot() {
    const state = this.longSession;
    if (!state?.active) {
      return { active: false };
    }

    return {
      active: true,
      processing: state.processing,
      queuedChunks: state.queuedChunks,
      completedChunks: state.completedChunks,
      pendingChunks: state.queue.length,
      errorCount: state.errors.length,
      recordedSeconds: Math.round(state.recordedSeconds),
      transcribedSeconds: Math.round(state.transcribedSeconds),
    };
  }

  resetLongSessionState() {
    if (this.longSessionSegment) {
      void this.stopLongSessionSegmentCapture({ discard: true });
    }
    this.longSession = this.createLongSessionState();
    this.recordingChunkDurationsMs = [];
    this.lastRecorderDataAt = null;
    this.longSessionPromotionUnavailable = false;
  }

  cancelLongSessionWork() {
    if (!this.longSession?.active) {
      return;
    }

    this.longSession.cancelled = true;
    this.longSession.queue = [];
    void this.stopLongSessionSegmentCapture({ discard: true });
  }

  getTranscriptionSetting(key, fallback = "") {
    if (
      this.transcriptionSettingsSnapshot &&
      Object.prototype.hasOwnProperty.call(this.transcriptionSettingsSnapshot, key)
    ) {
      const snapshotValue = this.transcriptionSettingsSnapshot[key];
      if (snapshotValue !== undefined && snapshotValue !== null) {
        return snapshotValue;
      }
    }

    if (typeof localStorage !== "undefined") {
      const storedValue = localStorage.getItem(key);
      if (storedValue !== null) {
        return storedValue;
      }
    }

    return fallback;
  }

  hasTranscriptionSettingSnapshot(key) {
    return (
      !!this.transcriptionSettingsSnapshot &&
      Object.prototype.hasOwnProperty.call(this.transcriptionSettingsSnapshot, key)
    );
  }

  invalidateTranscriptionRuntimeCaches() {
    this.cachedApiKey = null;
    this.cachedApiKeyProvider = null;
    this.cachedTranscriptionEndpoint = null;
    this.cachedEndpointProvider = null;
    this.cachedEndpointBaseUrl = null;
  }

  isCurrentProcessingGeneration(generation) {
    return this.isProcessing && generation === this.processingGeneration;
  }

  setActiveTranscriptionAbortController(controller, generation) {
    this.activeTranscriptionAbortController = controller;
    this.activeTranscriptionGeneration = generation;
  }

  clearActiveTranscriptionAbortController(generation = null) {
    if (
      generation !== null &&
      generation !== undefined &&
      generation !== this.activeTranscriptionGeneration
    ) {
      return;
    }

    this.activeTranscriptionAbortController = null;
    this.activeTranscriptionGeneration = 0;
  }

  abortActiveTranscriptionRequest() {
    if (this.activeTranscriptionAbortController) {
      try {
        this.activeTranscriptionAbortController.abort();
      } catch {
        // Ignore abort errors during cancellation/cleanup.
      }
    }
    this.clearActiveTranscriptionAbortController();
  }

  clearRecorderStopWatchdog() {
    if (this.recordingStopTimeoutId) {
      clearTimeout(this.recordingStopTimeoutId);
      this.recordingStopTimeoutId = null;
    }
  }

  waitForRecorderFinalData() {
    return new Promise((resolve) => setTimeout(resolve, RECORDER_FINAL_DATA_GRACE_MS));
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  estimateRecorderChunkDurationMs() {
    const now = Date.now();
    const elapsedMs = this.lastRecorderDataAt
      ? now - this.lastRecorderDataAt
      : RECORDER_TIMESLICE_MS;
    this.lastRecorderDataAt = now;

    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
      return RECORDER_TIMESLICE_MS;
    }

    return Math.min(Math.max(elapsedMs, 1000), this.longSessionChunkTargetMs * 2);
  }

  getBufferedRecordingDurationMs() {
    return this.recordingChunkDurationsMs.reduce((total, value) => total + value, 0);
  }

  handleRecorderData(data) {
    if (!data || data.size <= 0) {
      return;
    }

    const durationMs = this.estimateRecorderChunkDurationMs();

    if (this.longSession.active) {
      // Segment recorders are the only valid source once a long session is
      // running. The primary recorder emits mid-stream WebM fragments that
      // carry no EBML header, so FFmpeg rejects them outright ("EBML header
      // parsing failed"). Enqueuing one costs the whole dictation: the chunk
      // fails, exhausts its retries, and finalizeLongSessionResult then
      // discards every chunk that did transcribe. Drop them instead — the
      // segment recorders already cover this audio.
      return;
    }

    this.audioChunks.push(data);
    this.recordingChunkDurationsMs.push(durationMs);

    const elapsedMs = this.recordingStartTime ? Date.now() - this.recordingStartTime : 0;
    const bufferedMs = this.getBufferedRecordingDurationMs();
    if (
      !this.longSessionPromotionUnavailable &&
      Math.max(elapsedMs, bufferedMs) >= this.longSessionPromotionMs
    ) {
      this.promoteLongSession();
    }
  }

  promoteLongSession() {
    if (this.longSession.active) {
      return;
    }

    const state = this.createLongSessionState();
    state.active = true;
    state.sessionId = this.activeRecordingSessionId;
    state.promotedAt = Date.now();
    this.longSession = state;

    const initialSegment = this.longSessionSegment;
    if (!initialSegment && !this.startLongSessionSegmentCapture()) {
      this.longSession = this.createLongSessionState();
      this.longSessionPromotionUnavailable = true;
      logger.warn(
        "Long-session promotion skipped because segment capture is unavailable",
        { sessionId: this.activeRecordingSessionId },
        "audio"
      );
      this.emitStateChange();
      return;
    }

    const chunks = this.audioChunks;
    const promotedDurationMs =
      this.recordingStartTime && state.promotedAt
        ? state.promotedAt - this.recordingStartTime
        : this.getBufferedRecordingDurationMs();
    this.audioChunks = [];
    this.recordingChunkDurationsMs = [];

    if (initialSegment) {
      // The continuous recorder produces a self-contained WebM. Reassembling the
      // primary recorder's timeslice blobs can lose timestamp clusters in FFmpeg.
      void this.stopLongSessionSegmentCapture({ restart: true });
    } else if (chunks.length > 0) {
      this.enqueueLongSessionChunk(
        new Blob(chunks, { type: this.recordingMimeType || "audio/webm" }),
        Math.max(promotedDurationMs, RECORDER_TIMESLICE_MS)
      );
    }

    logger.info(
      "Recording promoted to long-session transcription",
      {
        sessionId: state.sessionId,
        queuedChunks: state.queuedChunks,
        recordedSeconds: Math.round(state.recordedSeconds),
        segmentCaptureActive: !!this.longSessionSegment,
      },
      "audio"
    );

    this.emitStateChange();
  }

  enqueueLongSessionChunk(blob, durationMs = RECORDER_TIMESLICE_MS, options = {}) {
    const state = this.longSession;
    if (!state.active || state.cancelled) {
      return;
    }

    const item = {
      index: state.nextChunkIndex++,
      blob,
      durationMs,
      sessionId: state.sessionId,
      attempts: 0,
      trimTrailingSilence: options.trimTrailingSilence === true,
    };

    state.queue.push(item);
    state.queuedChunks += 1;
    state.recordedSeconds += durationMs / 1000;
    this.emitStateChange();
    void this.drainLongSessionQueue();
  }

  startLongSessionSegmentCapture({ promotionCapture = false } = {}) {
    if (this.longSessionSegment || !this.recordingStream) {
      return false;
    }

    try {
      const recorder = new MediaRecorder(this.recordingStream);
      const segment = {
        recorder,
        chunks: [],
        startedAt: Date.now(),
        rotateTimer: null,
        pauseHeldMs: 0,
        stopping: false,
        discard: false,
        restartAfterStop: false,
        promotionCapture,
        stopResolvers: [],
        finished: false,
      };

      recorder.ondataavailable = (event) => {
        if (event?.data && event.data.size > 0) {
          segment.chunks.push(event.data);
        }
      };

      recorder.onstop = () => {
        this.finishLongSessionSegment(segment);
      };

      recorder.onerror = (event) => {
        logger.warn(
          "Long-session segment recorder reported an error",
          {
            message: event?.error?.message || "Unknown recorder error",
          },
          "audio"
        );
      };

      this.longSessionSegment = segment;
      recorder.start();
      if (!promotionCapture) {
        segment.rotateTimer = setTimeout(() => {
          segment.rotateTimer = null;
          this.rotateLongSessionSegmentAtNextPause(segment);
        }, LONG_SESSION_SEGMENT_MS);
      }
      return true;
    } catch (error) {
      this.longSessionSegment = null;
      logger.warn(
        "Failed to start long-session segment recorder; falling back to recorder chunks",
        { error: error?.message },
        "audio"
      );
      return false;
    }
  }

  finishLongSessionSegment(segment) {
    if (segment.finished) {
      return;
    }
    segment.finished = true;

    if (segment.rotateTimer) {
      clearTimeout(segment.rotateTimer);
      segment.rotateTimer = null;
    }

    const durationMs = Math.max(Date.now() - segment.startedAt, 1000);
    const shouldRestart =
      segment.restartAfterStop && this.longSession.active && !this.longSession.cancelled;

    if (!segment.discard && segment.chunks.length > 0 && this.longSession.active) {
      // Every chunk is trimmed, not just the last one. A speaker who stops to
      // think leaves an intermediate chunk ending in a long silence, and
      // Whisper fills that silence with invented sentences that land in the
      // middle of the transcript. A chunk cut mid-speech has no trailing
      // silence, so trimming it is a no-op.
      this.enqueueLongSessionChunk(
        new Blob(segment.chunks, { type: segment.recorder.mimeType || this.recordingMimeType }),
        durationMs,
        { trimTrailingSilence: true }
      );
    }

    if (this.longSessionSegment === segment) {
      this.longSessionSegment = null;
    }

    const resolvers = segment.stopResolvers.splice(0);
    resolvers.forEach((resolve) => resolve());

    if (shouldRestart) {
      this.startLongSessionSegmentCapture();
    }
  }

  /**
   * Tap the live recording stream so segment rotation can wait for a pause.
   * Returns null when Web Audio is unavailable or refuses the stream; callers
   * then fall back to rotating on the wall clock.
   */
  ensureSegmentLevelAnalyser() {
    if (this.segmentLevelAnalyser) {
      return this.segmentLevelAnalyser;
    }

    const stream = this.recordingStream;
    if (!stream) {
      return null;
    }

    try {
      // Must be the shared context. A per-recording AudioContext can get stuck
      // "suspended" on Windows after sleep/wake and then reports pure silence,
      // which this detector would read as a pause and cut on immediately.
      const context = getSharedAudioContext();
      if (!context) {
        return null;
      }

      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);

      this.segmentLevelAnalyser = {
        context,
        source,
        analyser,
        samples: new Float32Array(analyser.fftSize),
      };
      return this.segmentLevelAnalyser;
    } catch (error) {
      this.segmentLevelAnalyser = null;
      logger.debug(
        "Segment pause detection unavailable; rotating on the wall clock",
        { error: error?.message },
        "audio"
      );
      return null;
    }
  }

  disposeSegmentLevelAnalyser() {
    this.stopSpeechLevelMonitor();
    this.releaseSegmentLevelNode();
  }

  releaseSegmentLevelNode() {
    const node = this.segmentLevelAnalyser;
    this.segmentLevelAnalyser = null;
    if (!node) {
      return;
    }

    try {
      // The context is shared across recordings and deliberately not closed.
      node.source.disconnect();
      node.analyser.disconnect();
    } catch {
      // Ignore teardown errors from an already-disconnected graph.
    }
  }

  /**
   * Sample the microphone for the whole of a dictation.
   *
   * The readings are what lets `processAudio` refuse to transcribe a recording
   * nobody spoke into. Whisper answers silence with an invented stock phrase
   * ("Thank you.") that then gets pasted, and no engine setting turns that off,
   * so the recording is judged here instead.
   *
   * Costs nothing per reading - it reuses the analyser segment rotation
   * already taps the live stream with. Returns false when Web Audio refuses
   * the stream, and the dictation is then transcribed as it always was.
   */
  startSpeechLevelMonitor() {
    this.stopSpeechLevelMonitor();

    if (!this.ensureSegmentLevelAnalyser()) {
      return false;
    }

    const monitor = { timer: null, levels: [] };
    const poll = () => {
      monitor.timer = null;
      if (this.speechLevelMonitor !== monitor) {
        return;
      }

      // null means unmeasurable right now, typically a context the OS
      // suspended. Recording it as a level would read as silence.
      const rms = this.readSegmentLevelRms();
      if (rms !== null) {
        monitor.levels.push(rms);
      }

      monitor.timer = setTimeout(poll, SPEECH_LEVEL_POLL_MS);
    };

    this.speechLevelMonitor = monitor;
    monitor.timer = setTimeout(poll, SPEECH_LEVEL_POLL_MS);
    return true;
  }

  stopSpeechLevelMonitor() {
    const monitor = this.speechLevelMonitor;
    this.speechLevelMonitor = null;
    if (monitor?.timer) {
      clearTimeout(monitor.timer);
      monitor.timer = null;
    }
  }

  /**
   * The verdict on the recording that just ended, taken before teardown
   * disposes the analyser. Always safe to call: with no monitor running it
   * reports "not measured", which callers treat as speech.
   */
  takeSpeechLevelSummary() {
    const levels = this.speechLevelMonitor?.levels ?? [];
    this.stopSpeechLevelMonitor();
    return summarizeSpeechLevels(levels);
  }

  /**
   * The same verdict, read from the finished recording instead of the live
   * meter. A recording that cannot be decoded reports "not measured", which
   * callers treat as speech.
   */
  async measureRecordedSpeechLevel(audioBlob) {
    try {
      const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!OfflineContext) {
        return summarizeSpeechLevels([]);
      }

      const decoder = new OfflineContext(1, 1, RECORDED_LEVEL_SAMPLE_RATE);
      const audio = await decoder.decodeAudioData(await audioBlob.arrayBuffer());
      const channels = Array.from({ length: audio.numberOfChannels }, (_, index) =>
        audio.getChannelData(index)
      );
      const frameLength = Math.round((audio.sampleRate * SPEECH_LEVEL_POLL_MS) / 1000);
      return summarizeSpeechLevels(frameRmsLevels(channels, frameLength));
    } catch (error) {
      logger.debug(
        "Could not measure the recording; transcribing it",
        { error: error?.message },
        "audio"
      );
      return summarizeSpeechLevels([]);
    }
  }

  readSegmentLevelRms() {
    let node = this.segmentLevelAnalyser;
    if (!node) {
      return null;
    }

    // The overlay's level meter replaces the shared context when it stops
    // rendering. Follow it: an analyser left on the closed context reads
    // nothing for the rest of the recording, and the speech gate would judge
    // the whole dictation on what it heard before the swap.
    if (node.context !== getSharedAudioContext()) {
      this.releaseSegmentLevelNode();
      node = this.ensureSegmentLevelAnalyser();
      if (!node) {
        return null;
      }
    }

    // A suspended context hands back zeros forever. Treating that as a pause
    // would cut every segment on the wall clock again, silently.
    if (node.context.state !== "running") {
      void node.context.resume?.().catch?.(() => {});
      return null;
    }

    try {
      node.analyser.getFloatTimeDomainData(node.samples);
    } catch {
      return null;
    }

    let sumOfSquares = 0;
    for (let i = 0; i < node.samples.length; i += 1) {
      sumOfSquares += node.samples[i] * node.samples[i];
    }
    const rms = Math.sqrt(sumOfSquares / node.samples.length);
    return Number.isFinite(rms) ? rms : null;
  }

  rotateLongSessionSegmentAtNextPause(segment) {
    if (segment.finished || segment.stopping || this.longSessionSegment !== segment) {
      return;
    }

    if (!this.ensureSegmentLevelAnalyser()) {
      void this.rotateLongSessionSegment();
      return;
    }

    segment.pauseHeldMs = 0;

    const poll = () => {
      segment.rotateTimer = null;
      if (segment.finished || segment.stopping || this.longSessionSegment !== segment) {
        return;
      }

      // A null reading means the level is unmeasurable right now (typically a
      // context the OS suspended). Never treat that as a pause — unmeasurable
      // is not silent. Hold the boundary and let the hard cap end the segment
      // if the reading never comes back.
      const rms = this.readSegmentLevelRms();
      if (rms !== null) {
        segment.pauseHeldMs =
          rms < LONG_SESSION_SEGMENT_PAUSE_RMS
            ? segment.pauseHeldMs + LONG_SESSION_SEGMENT_PAUSE_POLL_MS
            : 0;
      }

      const elapsedMs = Date.now() - segment.startedAt;
      if (
        segment.pauseHeldMs >= LONG_SESSION_SEGMENT_PAUSE_HOLD_MS ||
        elapsedMs >= LONG_SESSION_SEGMENT_MAX_MS
      ) {
        void this.rotateLongSessionSegment();
        return;
      }

      segment.rotateTimer = setTimeout(poll, LONG_SESSION_SEGMENT_PAUSE_POLL_MS);
    };

    segment.rotateTimer = setTimeout(poll, LONG_SESSION_SEGMENT_PAUSE_POLL_MS);
  }

  rotateLongSessionSegment() {
    return this.stopLongSessionSegmentCapture({ restart: true });
  }

  stopLongSessionSegmentCapture({ discard = false, restart = false } = {}) {
    const segment = this.longSessionSegment;
    if (!segment) {
      return Promise.resolve();
    }

    segment.discard = discard;
    segment.restartAfterStop = restart && !discard;

    if (segment.rotateTimer) {
      clearTimeout(segment.rotateTimer);
      segment.rotateTimer = null;
    }

    return new Promise((resolve) => {
      segment.stopResolvers.push(resolve);

      if (segment.stopping) {
        return;
      }

      if (segment.recorder.state === "inactive") {
        this.finishLongSessionSegment(segment);
        return;
      }

      segment.stopping = true;
      try {
        segment.recorder.requestData?.();
      } catch {
        // Ignore requestData errors from some browsers/recorders.
      }

      try {
        segment.recorder.stop();
      } catch {
        this.finishLongSessionSegment(segment);
      }
    });
  }

  async drainLongSessionQueue() {
    const state = this.longSession;
    if (!state.active || state.cancelled) {
      return;
    }

    if (state.processingPromise) {
      return state.processingPromise;
    }

    state.processing = true;
    this.emitStateChange();

    state.processingPromise = (async () => {
      while (state.queue.length > 0 && !state.cancelled) {
        const item = state.queue.shift();
        if (!item || item.sessionId !== state.sessionId) {
          continue;
        }

        try {
          item.attempts += 1;
          const result = await this.runTranscription(item.blob, {
            durationSeconds: item.durationMs / 1000,
            source: "long-session",
            skipPostProcessing: true,
            skipOptimization: true,
            chunkIndex: item.index,
            trimTrailingSilence: item.trimTrailingSilence,
            lockedLanguage: state.detectedLanguage,
          });

          // Segments are transcribed one at a time, so the language learned
          // here is already pinned by the time the next one is submitted.
          if (!state.detectedLanguage) {
            const detected = result?.result?.detectedLanguage;
            if (detected) {
              state.detectedLanguage = detected;
              logger.info(
                "Locked auto-detected language for remaining long-session chunks",
                { language: detected, decidedByChunk: item.index },
                "transcription"
              );
            }
          }

          this.recordLongSessionChunkTelemetry(state, item, result);
          const text = String(result?.result?.text || "").trim();
          if (text) {
            state.results.set(item.index, text);
          }
          state.completedChunks += 1;
          state.transcribedSeconds += item.durationMs / 1000;
        } catch (error) {
          state.performanceTimingComplete = false;
          if (state.cancelled || error?.name === "AbortError") {
            return;
          }

          if (item.attempts < LONG_SESSION_CHUNK_MAX_ATTEMPTS) {
            state.queue.unshift(item);
            logger.warn(
              "Retrying failed long-session chunk",
              {
                chunkIndex: item.index,
                attempt: item.attempts + 1,
                maxAttempts: LONG_SESSION_CHUNK_MAX_ATTEMPTS,
                error: error?.message,
              },
              "transcription"
            );
            if (this.longSessionChunkRetryBackoffMs > 0) {
              await this.delay(this.longSessionChunkRetryBackoffMs);
            }
            continue;
          }

          // Keep the audio. The queue is still draining behind this chunk, so
          // whatever broke it may well be gone by the time the recording ends,
          // and finalizeLongSessionResult gets one more attempt at it.
          state.errors.push({
            index: item.index,
            message: error?.message || "Chunk transcription failed",
            toast: error?.toast,
            item,
          });
          logger.warn(
            "Long-session chunk transcription failed",
            {
              chunkIndex: item.index,
              error: error?.message,
            },
            "transcription"
          );
        } finally {
          this.emitStateChange();
        }
      }
    })();

    try {
      await state.processingPromise;
    } finally {
      if (this.longSession === state) {
        state.processing = false;
        state.processingPromise = null;
        this.emitStateChange();

        if (state.queue.length > 0 && !state.cancelled) {
          void this.drainLongSessionQueue();
        }
      }
    }
  }

  async waitForLongSessionQueue() {
    while (this.longSession?.processingPromise) {
      await this.longSession.processingPromise;
    }
  }

  // Chunks that exhausted their inline retries kept their audio. By the time
  // the recording ends the queue has drained and nothing else is competing for
  // whisper-server, so a transient failure (a busy server, a restart, a
  // timeout) usually clears. Spend one last attempt here rather than reporting
  // a gap the user could have had filled.
  async retryFailedLongSessionChunks() {
    const state = this.longSession;
    if (!state || state.cancelled || state.errors.length === 0) {
      return;
    }

    const pending = state.errors.filter((entry) => entry.item?.blob);
    if (pending.length === 0) {
      return;
    }

    state.errors = state.errors.filter((entry) => !entry.item?.blob);

    for (const entry of pending) {
      const item = entry.item;

      if (state.cancelled) {
        state.errors.push({ index: entry.index, message: entry.message, toast: entry.toast });
        continue;
      }

      try {
        const result = await this.runTranscription(item.blob, {
          durationSeconds: item.durationMs / 1000,
          source: "long-session",
          skipPostProcessing: true,
          skipOptimization: true,
          chunkIndex: item.index,
          trimTrailingSilence: item.trimTrailingSilence,
        });

        this.recordLongSessionChunkTelemetry(state, item, result);
        const text = String(result?.result?.text || "").trim();
        if (text) {
          state.results.set(item.index, text);
        }
        state.completedChunks += 1;
        logger.info(
          "Recovered a failed long-session chunk on the final retry",
          { chunkIndex: item.index, recoveredCharacters: text.length },
          "transcription"
        );
      } catch (error) {
        state.errors.push({
          index: entry.index,
          message: error?.message || entry.message,
          toast: error?.toast || entry.toast,
        });
      }
    }

    this.emitStateChange();
  }

  // Joins the transcribed chunks in order, standing a marker where a chunk is
  // missing. Silent chunks contribute nothing and are not gaps.
  buildLongSessionText(state) {
    const failedIndexes = new Set(state.errors.map((entry) => entry.index));
    const indexes = [...new Set([...state.results.keys(), ...failedIndexes])].sort(
      (left, right) => left - right
    );

    const parts = [];
    for (const index of indexes) {
      if (failedIndexes.has(index)) {
        parts.push(MISSING_SECTION_MARKER);
        continue;
      }
      const text = String(state.results.get(index) || "").trim();
      if (text) {
        parts.push(text);
      }
    }

    return parts.join(" ").trim();
  }

  // AI cleanup rewrites the transcript, and a bracketed marker is exactly the
  // kind of stray text it likes to tidy away. The gap is still real, so put
  // back any marker the model dropped. Position is lost at that point, so the
  // recovered markers land at the end rather than not appearing at all.
  preserveMissingSectionMarkers(text, expectedMarkers) {
    if (!expectedMarkers) {
      return text;
    }

    const present = text.split(MISSING_SECTION_MARKER).length - 1;
    if (present >= expectedMarkers) {
      return text;
    }

    const missing = Array.from({ length: expectedMarkers - present }, () => MISSING_SECTION_MARKER);
    return `${text} ${missing.join(" ")}`.trim();
  }

  async finalizeLongSessionResult(durationSeconds) {
    await this.waitForLongSessionQueue();
    await this.retryFailedLongSessionChunks();

    const state = this.longSession;

    const transcribedText = [...state.results.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, text]) => text)
      .filter(Boolean)
      .join(" ")
      .trim();

    // A failed chunk used to discard the whole dictation, so one bad section
    // out of five cost the speaker every word they said. Keep what did
    // transcribe and flag it as incomplete; only give up when nothing survived.
    if (!transcribedText) {
      if (state.errors.length > 0) {
        // The chunk's toast button (Switch to Whisper) still applies to the whole recording.
        throw Object.assign(
          new Error(
            `Long recording could not be transcribed after retrying chunk ${state.errors[0].index + 1}: ${state.errors[0].message}`
          ),
          { toast: state.errors[0].toast }
        );
      }
      throw new Error("No text transcribed - audio may be silent or unavailable");
    }

    const rawText = this.buildLongSessionText(state);

    if (state.errors.length > 0) {
      logger.warn(
        "Returning a partial long-session transcript",
        {
          failedChunks: state.errors.length,
          completedChunks: state.completedChunks,
          firstError: state.errors[0]?.message,
        },
        "transcription"
      );
    }

    const reasoningStart = performance.now();
    const reasonedText = await this.processTranscription(rawText, "long-session");
    const text = this.preserveMissingSectionMarkers(reasonedText || rawText, state.errors.length);
    const source = (await this.isReasoningAvailable()) ? "long-session-reasoned" : "long-session";
    const telemetry = this.summarizeLongSessionTelemetry(state);
    const { transcriptionProcessingDurationMs, transcriptionAudioDurationSeconds } = telemetry;
    const hasPairedTiming =
      Number.isFinite(transcriptionProcessingDurationMs) &&
      Number.isFinite(transcriptionAudioDurationSeconds);

    return {
      success: true,
      text,
      source,
      durationSeconds,
      activeModel: telemetry.activeModel,
      computeMode: telemetry.computeMode,
      timings: {
        // Both or neither: a speed built from one chunk's audio and another
        // chunk's clock would be a number nobody can act on.
        ...(hasPairedTiming
          ? { transcriptionProcessingDurationMs, transcriptionAudioDurationSeconds }
          : {}),
        reasoningProcessingDurationMs: Math.round(performance.now() - reasoningStart),
      },
      longSession: {
        chunks: state.completedChunks,
        failedChunks: state.errors.length,
        totalChunks: state.completedChunks + state.errors.length,
      },
    };
  }

  stopRecordingStream() {
    this.disposeSegmentLevelAnalyser();

    const stream = this.recordingStream || this.mediaRecorder?.stream || null;
    if (!stream) {
      this.recordingStream = null;
      return;
    }

    try {
      stream.getTracks().forEach((track) => track.stop());
    } catch {
      // Ignore stream cleanup errors.
    }

    this.recordingStream = null;
  }

  releaseMediaRecorder() {
    this.clearRecorderStopWatchdog();
    this.disposeSegmentLevelAnalyser();

    if (this.mediaRecorder) {
      this.mediaRecorder.ondataavailable = null;
      this.mediaRecorder.onstop = null;
      this.mediaRecorder.onerror = null;
    }

    this.recordingStream = null;
    this._scheduleStreamRelease();
    this.mediaRecorder = null;
    this.activeRecordingSessionId = null;
  }

  getRecordingDurationSeconds() {
    return this.recordingStartTime ? (Date.now() - this.recordingStartTime) / 1000 : null;
  }

  scheduleRecorderStopWatchdog({ discard, timeoutMs = RECORDER_STOP_TIMEOUT_MS }) {
    this.clearRecorderStopWatchdog();
    const activeSessionId = this.activeRecordingSessionId;

    this.recordingStopTimeoutId = setTimeout(() => {
      if (!this.isRecording || activeSessionId !== this.activeRecordingSessionId) {
        return;
      }

      logger.warn(
        "Recorder stop timeout reached; forcing finalization",
        {
          discard,
          recorderState: this.mediaRecorder?.state,
          activeSessionId,
        },
        "audio"
      );

      void this.forceFinalizeRecording({ discard });
    }, timeoutMs);
  }

  async forceFinalizeRecording({ discard = false } = {}) {
    if (!this.isRecording && !this.isStartingRecording) {
      return false;
    }

    const durationSeconds = this.getRecordingDurationSeconds();
    const wasLongSession = this.longSession.active;
    const audioBlob = wasLongSession
      ? null
      : new Blob(this.audioChunks, { type: this.recordingMimeType || "audio/webm" });
    const chunksCount = this.audioChunks.length;
    // Read before releaseMediaRecorder() below disposes the analyser.
    const speechLevel = this.takeSpeechLevelSummary();

    this.audioChunks = [];
    this.recordingChunkDurationsMs = [];
    this.recordingStartTime = null;
    this.isRecording = false;
    this.isStartingRecording = false;
    this.isStoppingRecording = false;
    this.pendingStopAfterStart = false;
    this.pendingCancelAfterStart = false;
    this.discardCurrentRecording = false;
    if (!wasLongSession) {
      void this.stopLongSessionSegmentCapture({ discard: true });
    }
    this.releaseMediaRecorder();

    if (discard) {
      this.cancelLongSessionWork();
      this.resetLongSessionState();
      this.isProcessing = false;
      this.emitStateChange();
      return true;
    }

    if (wasLongSession) {
      this.isProcessing = true;
      this.emitStateChange();
      await this.processLongSessionAudio({ durationSeconds });
      return true;
    }

    if (audioBlob.size === 0) {
      this.isProcessing = false;
      this.emitStateChange();

      logger.warn("Forced finalize produced empty audio blob", { chunksCount }, "audio");
      return true;
    }

    this.isProcessing = true;
    this.emitStateChange();

    logger.info(
      "Recording forced to stop",
      {
        blobSize: audioBlob.size,
        blobType: audioBlob.type,
        chunksCount,
        durationSeconds,
      },
      "audio"
    );

    await this.processAudio(audioBlob, { durationSeconds, speechLevel });
    return true;
  }

  async getAudioConstraints() {
    const preference = {
      preferBuiltInMic: localStorage.getItem("preferBuiltInMic") !== "false",
      selectedMicDeviceId: localStorage.getItem("selectedMicDeviceId") || "",
    };

    let audioInputs = this._cachedAudioInputs;
    if (!audioInputs) {
      try {
        audioInputs = (await navigator.mediaDevices.enumerateDevices()).filter(
          (d) => d.kind === "audioinput"
        );
      } catch (error) {
        logger.debug(
          "Failed to enumerate audio inputs, falling back to the default device",
          { error: error.message },
          "audio"
        );
        audioInputs = [];
      }
    }

    // Same resolver the picker, the mic test, and the dashboard readout use, so
    // what a test proves is what a dictation records.
    const constraints = buildMicrophoneConstraints(audioInputs, preference);
    logger.debug(
      "Resolved microphone",
      {
        deviceId: constraints.audio?.deviceId?.exact || "default",
        label: describeMicrophoneSelection(audioInputs, preference),
      },
      "audio"
    );

    return constraints;
  }

  // Fire-and-forget pre-warm of the local transcription server so the model
  // loads into memory while the user is still speaking instead of serially
  // after they stop. Server startup is idempotent: an in-flight start is
  // shared with the transcription request, and the idle timeout still
  // applies, so a cancelled dictation never keeps the engine alive longer
  // than a completed one would. Transcription behavior is unchanged —
  // language, dictionary prompt, and decoding options are sent per request.
  _preWarmLocalTranscriptionServer() {
    try {
      if (typeof window === "undefined" || !window.electronAPI) return;
      if (this.getTranscriptionSetting("useLocalWhisper", "false") !== "true") return;

      const provider = this.getTranscriptionSetting("localTranscriptionProvider", "whisper");
      if (provider === "nvidia") {
        const model = this.getTranscriptionSetting("parakeetModel", "parakeet-tdt-0.6b-v3");
        window.electronAPI.parakeetServerStart?.(model)?.catch?.(() => {});
      } else {
        const model = this.getTranscriptionSetting("whisperModel", "base");
        window.electronAPI.whisperServerStart?.(model)?.catch?.(() => {});
      }
    } catch {
      // Pre-warming is an optimization only; never block or fail recording.
    }
  }

  async startRecording() {
    let stream = null;

    try {
      if (
        this.isRecording ||
        this.isProcessing ||
        this.isStartingRecording ||
        this.mediaRecorder?.state === "recording"
      ) {
        return false;
      }

      this.isStartingRecording = true;
      this.pendingStopAfterStart = false;
      this.pendingCancelAfterStart = false;
      this.discardCurrentRecording = false;

      this._preWarmLocalTranscriptionServer();

      const constraints = await this.getAudioConstraints();
      stream = await this._acquireStream(constraints);

      // Log which microphone is actually being used
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        const settings = audioTrack.getSettings();
        logger.info(
          "Recording started with microphone",
          {
            label: audioTrack.label,
            deviceId: settings.deviceId?.slice(0, 20) + "...",
            sampleRate: settings.sampleRate,
            channelCount: settings.channelCount,
          },
          "audio"
        );
      }

      if (this.pendingCancelAfterStart) {
        this._scheduleStreamRelease();
        this.isStartingRecording = false;
        this.pendingCancelAfterStart = false;
        this.pendingStopAfterStart = false;
        return false;
      }

      this.recordingStream = stream;
      this.mediaRecorder = new MediaRecorder(stream);
      const sessionId = ++this.recordingSessionCounter;
      this.activeRecordingSessionId = sessionId;
      this.audioChunks = [];
      this.recordingChunkDurationsMs = [];
      this.lastRecorderDataAt = null;
      this.resetLongSessionState();
      this.recordingStartTime = Date.now();
      this.recordingMimeType = this.mediaRecorder.mimeType || "audio/webm";

      this.mediaRecorder.ondataavailable = (event) => {
        if (sessionId !== this.activeRecordingSessionId) {
          return;
        }
        this.handleRecorderData(event?.data);
      };

      this.mediaRecorder.onerror = (event) => {
        if (sessionId !== this.activeRecordingSessionId) {
          return;
        }

        logger.warn(
          "MediaRecorder reported an error",
          {
            message: event?.error?.message || "Unknown recorder error",
            recorderState: this.mediaRecorder?.state,
          },
          "audio"
        );
      };

      this.mediaRecorder.onstop = async () => {
        if (sessionId !== this.activeRecordingSessionId) {
          return;
        }

        this.clearRecorderStopWatchdog();
        await this.waitForRecorderFinalData();
        if (sessionId !== this.activeRecordingSessionId) {
          return;
        }

        const shouldDiscard = this.discardCurrentRecording;
        const durationSeconds = this.getRecordingDurationSeconds();
        const wasLongSession = this.longSession.active;
        const audioBlob = wasLongSession
          ? null
          : new Blob(this.audioChunks, {
              type: this.recordingMimeType || "audio/webm",
            });
        const chunksCount = this.audioChunks.length;
        // Read before releaseMediaRecorder() below disposes the analyser.
        const speechLevel = this.takeSpeechLevelSummary();

        this.audioChunks = [];
        this.recordingChunkDurationsMs = [];
        this.recordingStartTime = null;
        this.isRecording = false;
        this.isStartingRecording = false;
        this.isStoppingRecording = false;
        this.pendingStopAfterStart = false;
        this.pendingCancelAfterStart = false;
        this.discardCurrentRecording = false;
        if (!wasLongSession) {
          void this.stopLongSessionSegmentCapture({ discard: true });
        }
        this.releaseMediaRecorder();

        if (shouldDiscard) {
          this.cancelLongSessionWork();
          this.resetLongSessionState();
          this.isProcessing = false;
          this.emitStateChange();
          return;
        }

        this.isProcessing = true;
        this.emitStateChange();

        if (wasLongSession) {
          logger.info(
            "Long recording stopped",
            {
              queuedChunks: this.longSession.queuedChunks,
              completedChunks: this.longSession.completedChunks,
              pendingChunks: this.longSession.queue.length,
              durationSeconds,
            },
            "audio"
          );

          await this.processLongSessionAudio({ durationSeconds });
          return;
        }

        // Debug: Log audio blob info
        logger.info(
          "Recording stopped",
          {
            blobSize: audioBlob.size,
            blobType: audioBlob.type,
            chunksCount,
            durationSeconds,
          },
          "audio"
        );

        await this.processAudio(audioBlob, { durationSeconds, speechLevel });
      };

      // Flush long dictations into periodic chunks. Without a timeslice, Electron
      // can keep most of a multi-minute recording inside MediaRecorder until the
      // final stop flush. If that final flush is slow, the watchdog may process
      // only earlier data and the transcript appears truncated.
      this.mediaRecorder.start(RECORDER_TIMESLICE_MS);
      // Keep a continuous first segment in parallel. Chromium's timeslice blobs
      // are useful for normal short recordings, but joining several of them can
      // produce a WebM whose timestamp clusters FFmpeg decodes incompletely.
      // This recorder is discarded for short dictations and becomes chunk zero
      // only if the recording crosses the long-session threshold.
      this.startLongSessionSegmentCapture({ promotionCapture: true });
      this.startSpeechLevelMonitor();
      this.isRecording = true;
      this.isProcessing = false;
      this.isStartingRecording = false;
      this.isStoppingRecording = false;
      this.emitStateChange();

      if (this.pendingCancelAfterStart) {
        this.pendingCancelAfterStart = false;
        this.cancelRecording();
      } else if (this.pendingStopAfterStart) {
        this.pendingStopAfterStart = false;
        this.stopRecording();
      }

      return true;
    } catch (error) {
      this._clearPooledStream();

      this.audioChunks = [];
      this.recordingChunkDurationsMs = [];
      this.lastRecorderDataAt = null;
      this.cancelLongSessionWork();
      this.resetLongSessionState();
      this.recordingStartTime = null;
      this.isRecording = false;
      this.isProcessing = false;
      this.isStartingRecording = false;
      this.isStoppingRecording = false;
      this.pendingStopAfterStart = false;
      this.pendingCancelAfterStart = false;
      this.discardCurrentRecording = false;
      this.releaseMediaRecorder();

      // Provide more specific error messages
      let errorTitle = "Recording Error";
      let errorDescription = `Failed to access microphone: ${error.message}`;

      if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        errorTitle = "Microphone Access Denied";
        errorDescription =
          "Please grant microphone permission in your system settings and try again.";
      } else if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
        errorTitle = "No Microphone Found";
        errorDescription = "No microphone was detected. Please connect a microphone and try again.";
      } else if (error.name === "NotReadableError" || error.name === "TrackStartError") {
        errorTitle = "Microphone In Use";
        errorDescription =
          "The microphone is being used by another application. Please close other apps and try again.";
      }

      this.onError?.({
        title: errorTitle,
        description: errorDescription,
      });
      return false;
    }
  }

  stopRecording() {
    if (this.isStartingRecording) {
      this.pendingStopAfterStart = true;
      this.pendingCancelAfterStart = false;
      return true;
    }

    if (this.isStoppingRecording) {
      return true;
    }

    if (this.mediaRecorder?.state === "recording") {
      const durationMs = this.recordingStartTime ? Date.now() - this.recordingStartTime : null;
      const isTooShort = durationMs !== null && durationMs < MIN_DICTATION_DURATION_MS;

      this.discardCurrentRecording = isTooShort;
      this.isStoppingRecording = true;
      this.emitStateChange();

      if (isTooShort) {
        logger.debug(
          "Discarding recording shorter than the minimum dictation duration",
          { durationMs, minimumDurationMs: MIN_DICTATION_DURATION_MS },
          "audio"
        );
      }

      try {
        this.mediaRecorder.requestData?.();
      } catch {
        // Ignore requestData errors from some browsers/recorders.
      }

      try {
        this.mediaRecorder.stop();
      } catch (error) {
        logger.warn(
          "MediaRecorder stop failed; forcing finalization",
          { error: error?.message, discard: isTooShort },
          "audio"
        );
        void this.forceFinalizeRecording({ discard: isTooShort });
        return true;
      }

      this.scheduleRecorderStopWatchdog({
        discard: isTooShort,
        ...(isTooShort ? { timeoutMs: 350 } : {}),
      });
      // State change will be handled in onstop callback
      return true;
    }

    if (this.isRecording) {
      const durationMs = this.recordingStartTime ? Date.now() - this.recordingStartTime : null;
      const isTooShort = durationMs !== null && durationMs < MIN_DICTATION_DURATION_MS;
      logger.warn(
        "Recorder state drift detected during stop; forcing finalization",
        { recorderState: this.mediaRecorder?.state, durationMs, discard: isTooShort },
        "audio"
      );
      void this.forceFinalizeRecording({ discard: isTooShort });
      return true;
    }

    return false;
  }

  cancelRecording() {
    if (this.isStartingRecording) {
      this.pendingCancelAfterStart = true;
      this.pendingStopAfterStart = false;
      return true;
    }

    if (this.isStoppingRecording) {
      this.discardCurrentRecording = true;
      this.emitStateChange();
      return true;
    }

    if (this.mediaRecorder?.state === "recording") {
      this.discardCurrentRecording = true;
      this.isStoppingRecording = true;
      this.emitStateChange();
      try {
        this.mediaRecorder.requestData?.();
      } catch {
        // Ignore requestData errors from some browsers/recorders.
      }

      try {
        this.mediaRecorder.stop();
      } catch (error) {
        logger.warn(
          "MediaRecorder stop failed during cancellation; forcing cleanup",
          { error: error?.message },
          "audio"
        );
        void this.forceFinalizeRecording({ discard: true });
        return true;
      }

      this.scheduleRecorderStopWatchdog({ discard: true, timeoutMs: 350 });
      return true;
    }

    if (this.isRecording) {
      logger.warn(
        "Recorder state drift detected during cancel; forcing cleanup",
        { recorderState: this.mediaRecorder?.state },
        "audio"
      );
      void this.forceFinalizeRecording({ discard: true });
      return true;
    }

    return false;
  }

  cancelProcessing() {
    if (this.isProcessing) {
      this.processingGeneration += 1;
      this.abortActiveTranscriptionRequest();
      this.cancelLongSessionWork();
      this.isProcessing = false;
      this.emitStateChange();
      return true;
    }
    return false;
  }

  async processAudio(audioBlob, metadata = {}) {
    const pipelineStart = performance.now();
    const processingGeneration = ++this.processingGeneration;
    const processingMetadata = {
      ...metadata,
      processingGeneration,
    };
    try {
      // Nothing was said. Sending it anyway is how "Thank you." and other
      // invented stock phrases end up pasted into whatever the user was
      // typing in - Whisper has no way to answer "silence" and fills the gap
      // instead. Handled like the engines' own "No audio detected": the
      // recording is dropped and the overlay returns to idle without a toast,
      // because a hotkey pressed with nothing spoken is not an error.
      let speechLevel = metadata.speechLevel;
      let measuredFrom = "meter";
      // An unmuted microphone never reads exact digital zero from start to
      // finish. A muted one does, and so does a meter cut off from the stream -
      // and dropping on a deaf meter's word loses a real dictation. The
      // recording itself settles which.
      if (speechLevel?.measured && !speechLevel.speechDetected && speechLevel.peakRms === 0) {
        speechLevel = await this.measureRecordedSpeechLevel(audioBlob);
        measuredFrom = "recording";
        if (!this.isCurrentProcessingGeneration(processingGeneration)) {
          return;
        }
        if (speechLevel.measured && speechLevel.speechDetected) {
          logger.warn(
            "Level meter heard nothing, but the recording holds speech; transcribing",
            {
              readings: speechLevel.readings,
              peakRms: Number(speechLevel.peakRms.toFixed(5)),
              loudFrames: speechLevel.loudFrames,
            },
            "audio"
          );
        }
      }
      if (speechLevel && speechLevel.measured && !speechLevel.speechDetected) {
        logger.info(
          "Dictation held no speech; skipped transcription",
          {
            measuredFrom,
            durationSeconds: metadata.durationSeconds ?? null,
            readings: speechLevel.readings,
            peakRms: Number(speechLevel.peakRms.toFixed(5)),
            floorRms: Number(speechLevel.floorRms.toFixed(5)),
            loudFrames: speechLevel.loudFrames,
          },
          "audio"
        );
        return;
      }

      const { result, useLocalWhisper, localProvider, activeModel, computeMode } =
        await this.runTranscription(audioBlob, processingMetadata);

      if (!this.isCurrentProcessingGeneration(processingGeneration)) {
        return;
      }

      // Sound reached the microphone, but it was not speech: breath, a fan, a
      // keyboard. Whisper answers that with a subtitle annotation ("[Music]")
      // or a stock phrase ("Thank you."), and pastes it into whatever the user
      // was typing in. Neither the microphone level nor any decode threshold
      // separates this from quiet speech - measured, see nonSpeechArtifact.ts
      // - so it is caught here, on the text, for every provider at once.
      const artifact = classifyNonSpeechArtifact(result?.text, {
        durationSeconds: metadata.durationSeconds,
      });
      if (artifact.isArtifact) {
        logger.info(
          "Dropped a non-speech transcript",
          {
            reason: artifact.reason,
            text: result.text,
            durationSeconds: metadata.durationSeconds ?? null,
          },
          "transcription"
        );
        return;
      }

      // Add actual recording duration to result for stats tracking
      if (metadata.durationSeconds) {
        result.durationSeconds = metadata.durationSeconds;
      }
      result.processingGeneration = processingGeneration;
      // Carried so analytics can report which model produced this without
      // re-deriving the local/cloud choice from localStorage a second time.
      result.activeModel = activeModel;
      result.computeMode = computeMode;
      result.completeness = assessTranscriptionCompleteness({
        text: result.text,
        durationSeconds: result.durationSeconds ?? metadata.durationSeconds,
      });

      await this.onTranscriptionComplete?.(result, {
        processingGeneration,
        isCurrent: () => this.isCurrentProcessingGeneration(processingGeneration),
      });

      if (!this.isCurrentProcessingGeneration(processingGeneration)) {
        return;
      }

      const roundTripDurationMs = Math.round(performance.now() - pipelineStart);

      const timingData = {
        mode: useLocalWhisper ? `local-${localProvider}` : "cloud",
        model: activeModel,
        audioDurationMs: metadata.durationSeconds
          ? Math.round(metadata.durationSeconds * 1000)
          : null,
        reasoningProcessingDurationMs: result?.timings?.reasoningProcessingDurationMs ?? null,
        roundTripDurationMs,
        audioSizeBytes: audioBlob.size,
        audioFormat: audioBlob.type,
        outputTextLength: result?.text?.length,
      };

      if (useLocalWhisper) {
        timingData.audioConversionDurationMs = result?.timings?.audioConversionDurationMs ?? null;
      }
      timingData.transcriptionProcessingDurationMs =
        result?.timings?.transcriptionProcessingDurationMs ?? null;

      logger.info("Pipeline timing", timingData, "performance");
    } catch (error) {
      if (
        error?.name === "AbortError" ||
        !this.isCurrentProcessingGeneration(processingGeneration)
      ) {
        logger.debug(
          "Transcription request canceled",
          {
            processingGeneration,
          },
          "transcription"
        );
        return;
      }

      const errorAtMs = Math.round(performance.now() - pipelineStart);
      logger.error(
        "Pipeline failed",
        {
          errorAtMs,
          error: error.message,
        },
        "performance"
      );

      if (error.message !== "No audio detected") {
        this.onError?.(
          error.toast
            ? { ...error.toast }
            : {
                title: "Transcription Error",
                description: `Transcription failed: ${error.message}`,
              }
        );
      }
    } finally {
      this.clearActiveTranscriptionAbortController(processingGeneration);

      if (this.processingGeneration === processingGeneration && this.isProcessing) {
        this.isProcessing = false;
        this.emitStateChange();
      }
    }
  }

  async processLongSessionAudio({ durationSeconds } = {}) {
    const pipelineStart = performance.now();
    const processingGeneration = ++this.processingGeneration;

    try {
      await this.stopLongSessionSegmentCapture();
      const result = await this.finalizeLongSessionResult(durationSeconds);

      if (!this.isCurrentProcessingGeneration(processingGeneration)) {
        return;
      }

      result.processingGeneration = processingGeneration;
      result.completeness = assessTranscriptionCompleteness({
        text: result.text,
        durationSeconds,
      });

      // A partial transcript reads as a complete one, so it must never paste
      // silently. Known missing sections outrank the heuristic assessment.
      if (result.longSession?.failedChunks > 0) {
        result.completeness = {
          ...result.completeness,
          suspicious: true,
          reason: "failed-chunks",
          failedChunks: result.longSession.failedChunks,
          totalChunks: result.longSession.totalChunks,
        };
      }

      await this.onTranscriptionComplete?.(result, {
        processingGeneration,
        isCurrent: () => this.isCurrentProcessingGeneration(processingGeneration),
      });

      if (!this.isCurrentProcessingGeneration(processingGeneration)) {
        return;
      }

      logger.info(
        "Long-session pipeline timing",
        {
          audioDurationMs: durationSeconds ? Math.round(durationSeconds * 1000) : null,
          reasoningProcessingDurationMs: result?.timings?.reasoningProcessingDurationMs ?? null,
          roundTripDurationMs: Math.round(performance.now() - pipelineStart),
          outputTextLength: result?.text?.length,
          chunks: result?.longSession?.chunks,
          failedChunks: result?.longSession?.failedChunks,
        },
        "performance"
      );
    } catch (error) {
      if (
        error?.name === "AbortError" ||
        !this.isCurrentProcessingGeneration(processingGeneration)
      ) {
        logger.debug(
          "Long-session transcription canceled",
          {
            processingGeneration,
          },
          "transcription"
        );
        return;
      }

      logger.error(
        "Long-session pipeline failed",
        {
          errorAtMs: Math.round(performance.now() - pipelineStart),
          error: error.message,
        },
        "performance"
      );

      if (error.message !== "No audio detected") {
        this.onError?.({
          title: "Transcription Error",
          description: `Transcription failed: ${error.message}`,
          ...(error.toast?.action ? { action: error.toast.action } : {}),
        });
      }
    } finally {
      this.clearActiveTranscriptionAbortController(processingGeneration);
      this.resetLongSessionState();

      if (this.processingGeneration === processingGeneration && this.isProcessing) {
        this.isProcessing = false;
      }
      this.emitStateChange();
    }
  }

  async runTranscription(audioBlob, metadata = {}) {
    const useLocalWhisper = this.getTranscriptionSetting("useLocalWhisper", "false") === "true";
    let localProvider = this.getTranscriptionSetting("localTranscriptionProvider", "whisper");
    const whisperModel = this.getTranscriptionSetting("whisperModel", "base");
    const parakeetModel = this.getTranscriptionSetting("parakeetModel", "parakeet-tdt-0.6b-v3");

    let result;
    let activeModel;
    if (useLocalWhisper) {
      if (localProvider === "nvidia") {
        activeModel = parakeetModel;
        result = await this.processWithLocalParakeet(audioBlob, parakeetModel, metadata);
      } else {
        activeModel = whisperModel;
        result = await this.processWithLocalWhisper(audioBlob, whisperModel, metadata);
      }
    } else {
      activeModel = this.getTranscriptionModel();
      result = await this.processWithOpenAIAPI(audioBlob, metadata);
    }

    const source = result?.source || "";
    if (source.startsWith("openai")) {
      activeModel = result?.activeModel || this.getTranscriptionModel();
    } else if (source === "local-fallback") {
      activeModel =
        result?.activeModel || this.getTranscriptionSetting("fallbackWhisperModel", "small");
    } else {
      activeModel = result?.activeModel || activeModel;
    }

    // A Parakeet failure may have been retried on Whisper, which reports its own
    // engine; Parakeet's own results carry "cpu" (see processWithLocalParakeet).
    if (result?.localProvider) {
      localProvider = result.localProvider;
    }
    const computeMode = source.startsWith("openai") ? "cloud" : result?.computeMode || "unknown";

    return { result, useLocalWhisper, localProvider, activeModel, computeMode };
  }

  async processWithLocalWhisper(audioBlob, model = "base", metadata = {}) {
    const timings = {};

    try {
      // Correction Memory is a beta. Only read or inject its hints when beta
      // features are on.
      const correctionMemoryEnabled =
        typeof this._checkBetaFeatureAccess === "function" &&
        this._checkBetaFeatureAccess("correction-memory");
      const correctionHintsPromise = correctionMemoryEnabled
        ? this.refreshCorrectionHints()
        : Promise.resolve().then(() => {
            this._cachedCorrectionHints = [];
          });

      const smartContextPromise = isSmartContextEnabled()
        ? getContext({
            timeoutMs: 300,
            includeFileIdentifiers: isFileIdentifiersEnabled(),
          })
        : Promise.resolve(null);

      // Send original audio to main process - FFmpeg in main process handles conversion
      // (renderer-side AudioContext conversion was unreliable with WebM/Opus format)
      const audioBufferPromise = audioBlob.arrayBuffer();

      const [, smartContext, rawArrayBuffer] = await Promise.all([
        correctionHintsPromise,
        smartContextPromise,
        audioBufferPromise,
      ]);

      if (!correctionMemoryEnabled) {
        this._cachedCorrectionHints = [];
      }
      this._cachedSmartContext = smartContext;

      const arrayBuffer = toIpcSafeArrayBuffer(rawArrayBuffer);
      const rawLanguage = this.getTranscriptionSetting("preferredLanguage", "");
      const translateToEnglish = this.getTranscriptionSetting("translateToEnglish", "off");
      const resolvedLanguage = resolveTranscriptionLanguage(rawLanguage, "whisper", model);
      const options = {
        model,
      };
      if (metadata?.source === "long-session") {
        options.longSessionChunk = true;
        options.trimTrailingSilence = metadata.trimTrailingSilence === true;
      } else if (!metadata?.fileMode) {
        // Every dictation ends with silence — the speaker stops talking before
        // they reach for the hotkey. Whisper fills that silence by inventing a
        // continuation of the last sentence rather than ending the transcript,
        // so the recording arrives with text nobody spoke appended to it.
        // Trimming was previously applied only to long-session chunks, which
        // left every ordinary dictation exposed.
        options.trimTrailingSilence = true;
      }
      if (resolvedLanguage) {
        options.language = resolvedLanguage;
      } else if (metadata?.lockedLanguage) {
        // Auto-detect is still what the user asked for; we are only stopping
        // whisper from answering the question differently on every segment.
        options.language = metadata.lockedLanguage;
      } else {
        // Nothing has pinned the language, so this recording will be
        // auto-detected. Send the languages the user told us they speak so the
        // detector cannot answer with one of the neighbours they do not.
        options.allowedLanguages = readSpokenLanguages();
      }
      const shouldTranslate = shouldTranslateLocalWhisperToEnglish({
        translateToEnglish,
        // Deliberately the user's setting, not the locked language. Translation
        // stays gated on an explicit language choice, so auto-detect can never
        // start silently translating a recording into English.
        resolvedLanguage,
        model,
      });
      if (shouldTranslate) {
        options.translate = true;
      }
      if (metadata?.originalFileName) {
        options.inputFileName = metadata.originalFileName;
      }
      if (metadata?.fileMode) {
        options.fileMode = true;
        options.noiseReduction = metadata.noiseReduction === true;
        options.speakerDetection = metadata.speakerDetection === true;
        options.outputFormat = metadata.outputFormat || "plain";
      }

      logger.info(
        "Language resolved for local Whisper",
        {
          preferredLanguage: rawLanguage || "(not set)",
          translateToEnglish: translateToEnglish || "off",
          resolvedLanguage: resolvedLanguage || "(auto-detect)",
          fallbackToAuto: !!rawLanguage && rawLanguage !== "auto" && !resolvedLanguage,
          model,
        },
        "transcription"
      );

      // Add custom dictionary (and optional Smart Context hints) as initialPrompt.
      // Skip when translating — English-biased hints confuse whisper's translation mode.
      if (!options.translate) {
        const dictionaryPrompt = this.getCustomDictionaryPrompt();
        const contextHint = buildWhisperContextHint(this._cachedSmartContext);
        const fileIdHint = buildFileIdentifierHint(this._cachedSmartContext?.fileIdentifiers);
        const promptParts = [dictionaryPrompt, contextHint, fileIdHint].filter(Boolean);
        if (promptParts.length > 0) {
          options.initialPrompt = promptParts.join(". ");
        }
      }

      logger.debug(
        "Local transcription starting",
        {
          audioFormat: audioBlob.type,
          audioSizeBytes: audioBlob.size,
        },
        "performance"
      );

      const transcriptionStart = performance.now();
      const result = await window.electronAPI.transcribeLocalWhisper(arrayBuffer, options);
      timings.transcriptionProcessingDurationMs = Math.round(
        performance.now() - transcriptionStart
      );
      // What the engine spent decoding, without the model load a cold start
      // pays for. Kept beside the round trip rather than replacing it, because
      // the round trip is the wait the user actually sits through.
      if (Number.isFinite(result?.inferenceDurationMs) && result.inferenceDurationMs > 0) {
        timings.transcriptionInferenceDurationMs = Math.round(result.inferenceDurationMs);
      }

      logger.debug(
        "Local transcription complete",
        {
          transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
          transcriptionInferenceDurationMs: timings.transcriptionInferenceDurationMs ?? null,
          success: result.success,
        },
        "performance"
      );

      // A long-session chunk holding only silence is a normal outcome — the
      // speaker paused, or the recording ran on after they stopped talking.
      // It is not a failure: treating it as one exhausts the chunk's retries
      // and makes finalizeLongSessionResult discard the whole dictation.
      if (metadata?.source === "long-session" && !result.text) {
        return {
          success: true,
          text: "",
          source: "local",
          timings,
          computeMode: result.computeMode,
        };
      }

      if (result.success && result.text) {
        if (metadata?.skipPostProcessing) {
          // detectedLanguage is only present when the user is on auto-detect
          // and whisper reported something usable. Long-session chunks are the
          // consumer: the drain loop pins it for the rest of the recording.
          return {
            success: true,
            text: result.text,
            source: "local",
            timings,
            computeMode: result.computeMode,
            ...(result.detectedLanguage ? { detectedLanguage: result.detectedLanguage } : {}),
          };
        }

        const reasoningStart = performance.now();
        const text = await this.processTranscription(result.text, "local");
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        if (text !== null && text !== undefined) {
          return {
            success: true,
            text: text || result.text,
            source: "local",
            timings,
            computeMode: result.computeMode,
          };
        } else {
          throw new Error("No text transcribed");
        }
      } else if (result.success === false && result.message === "No audio detected") {
        throw new Error("No audio detected");
      } else {
        throw new Error(result.message || result.error || "Local Whisper transcription failed");
      }
    } catch (error) {
      if (error.message === "No audio detected") {
        throw error;
      }

      const allowOpenAIFallback =
        this.getTranscriptionSetting("allowOpenAIFallback", "false") === "true";
      const isLocalMode = this.getTranscriptionSetting("useLocalWhisper", "false") === "true";

      if (allowOpenAIFallback && isLocalMode) {
        try {
          const fallbackResult = await this.processWithOpenAIAPI(audioBlob, metadata);
          return { ...fallbackResult, source: "openai-fallback" };
        } catch (fallbackError) {
          throw new Error(
            `${formatLocalWhisperFailure(error.message)} OpenAI fallback also failed: ${fallbackError.message}`
          );
        }
      } else {
        throw new Error(formatLocalWhisperFailure(error.message));
      }
    }
  }

  async processWithLocalParakeet(audioBlob, model = "parakeet-tdt-0.6b-v3", metadata = {}) {
    const timings = {};
    let result;

    try {
      const arrayBuffer = toIpcSafeArrayBuffer(await audioBlob.arrayBuffer());
      const rawLanguage = this.getTranscriptionSetting("preferredLanguage", "");
      const resolvedLanguage = resolveTranscriptionLanguage(rawLanguage, "parakeet", model);
      const options = { model };
      if (resolvedLanguage) {
        options.language = resolvedLanguage;
      }
      if (metadata?.originalFileName) {
        options.inputFileName = metadata.originalFileName;
      }

      logger.info(
        "Language resolved for Parakeet",
        {
          preferredLanguage: rawLanguage || "(not set)",
          resolvedLanguage: resolvedLanguage || "(auto-detect)",
          fallbackToAuto: !!rawLanguage && rawLanguage !== "auto" && !resolvedLanguage,
          model,
        },
        "transcription"
      );

      logger.debug(
        "Parakeet transcription starting",
        {
          audioFormat: audioBlob.type,
          audioSizeBytes: audioBlob.size,
          model,
        },
        "performance"
      );

      const transcriptionStart = performance.now();
      result = await window.electronAPI.transcribeLocalParakeet(arrayBuffer, options);
      timings.transcriptionProcessingDurationMs = Math.round(
        performance.now() - transcriptionStart
      );
      // Decode time without the model load, as Whisper reports it.
      if (Number.isFinite(result?.decodeMs) && result.decodeMs > 0) {
        timings.transcriptionInferenceDurationMs = Math.round(result.decodeMs);
      }

      logger.debug(
        "Parakeet transcription complete",
        {
          transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
          transcriptionInferenceDurationMs: timings.transcriptionInferenceDurationMs ?? null,
          success: result?.success,
          noSpeech: Boolean(result?.noSpeech),
        },
        "performance"
      );
    } catch (error) {
      // The IPC handler rethrows engine failures (a crashed host, a timeout).
      return this.recoverFromParakeetFailure(audioBlob, describeParakeetFailure(error), metadata);
    }

    const noSpeech =
      (result?.success && (result.noSpeech || !String(result.text || "").trim())) ||
      (result?.success === false && result.message === "No audio detected");
    if (noSpeech) {
      // Whisper's two silence outcomes: a silent long-session piece is an empty
      // success, and a silent dictation is dropped with the "No Audio Detected" toast.
      if (metadata?.source === "long-session") {
        return { success: true, text: "", source: "local-parakeet", timings, computeMode: "cpu" };
      }
      this.onNoAudioDetected?.();
      throw new Error("No audio detected");
    }

    if (!result?.success) {
      return this.recoverFromParakeetFailure(audioBlob, describeParakeetFailure(result), metadata);
    }

    // sherpa-onnx-node runs on the CPU execution provider only.
    if (metadata?.skipPostProcessing) {
      return {
        success: true,
        text: result.text,
        source: "local-parakeet",
        timings,
        computeMode: "cpu",
      };
    }

    const reasoningStart = performance.now();
    const text = await this.processTranscription(result.text, "local-parakeet");
    timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

    if (text === null || text === undefined) {
      throw new Error("No text transcribed");
    }
    return {
      success: true,
      text: text || result.text,
      source: "local-parakeet",
      timings,
      computeMode: "cpu",
    };
  }

  // Parakeet decoded nothing usable. A missing model is a setup problem with its
  // own toast; anything else gets the same audio again on local Whisper, and the
  // cloud only when the user allowed it and no local Whisper could run.
  async recoverFromParakeetFailure(audioBlob, failure, metadata = {}) {
    if (failure.cancelled || this.isTranscriptionRequestCancelled(metadata)) {
      throw Object.assign(new Error("Transcription cancelled"), { name: "AbortError" });
    }

    if (failure.code === "model_not_found") {
      throw createToastError(`Parakeet failed: ${failure.message}`, {
        title: "Parakeet isn't downloaded yet",
        description: "Download it on the Dictation page, or choose a Whisper model there.",
        action: TRANSCRIPTION_TOAST_ACTIONS.OPEN_SPEECH_MODEL_SETTINGS,
      });
    }

    const whisperModel = await this.findFallbackWhisperModel();
    if (whisperModel) {
      logger.warn(
        "Parakeet failed; retrying the same audio with local Whisper",
        {
          error: failure.message,
          code: failure.code || null,
          whisperModel,
          longSessionChunk: metadata?.source === "long-session" ? metadata.chunkIndex : null,
        },
        "transcription"
      );
      try {
        const retry = await this.processWithLocalWhisper(audioBlob, whisperModel, metadata);
        // processWithLocalWhisper already handed it to the cloud when that was allowed.
        if (String(retry?.source || "").startsWith("openai")) {
          return retry;
        }
        return { ...retry, activeModel: whisperModel, localProvider: "whisper" };
      } catch (whisperError) {
        if (whisperError?.name === "AbortError" || whisperError?.message === "No audio detected") {
          throw whisperError;
        }
        throw new Error(
          `Parakeet failed: ${failure.message}. Local Whisper also failed: ${whisperError.message}`
        );
      }
    }

    const noLocalFallbackToast = {
      title: "Parakeet couldn't transcribe this",
      description:
        "Parakeet failed on this recording, and no Whisper model is installed to try instead.",
      action: TRANSCRIPTION_TOAST_ACTIONS.SWITCH_TO_WHISPER,
    };

    const allowOpenAIFallback =
      this.getTranscriptionSetting("allowOpenAIFallback", "false") === "true";
    const isLocalMode = this.getTranscriptionSetting("useLocalWhisper", "false") === "true";
    if (allowOpenAIFallback && isLocalMode) {
      logger.warn(
        "Parakeet failed and no Whisper model is installed; using the OpenAI fallback",
        { error: failure.message, code: failure.code || null },
        "transcription"
      );
      try {
        const fallbackResult = await this.processWithOpenAIAPI(audioBlob, metadata);
        return { ...fallbackResult, source: "openai-fallback" };
      } catch (fallbackError) {
        if (fallbackError?.name === "AbortError") {
          throw fallbackError;
        }
        throw createToastError(
          `Parakeet failed: ${failure.message}. OpenAI fallback also failed: ${fallbackError.message}`,
          noLocalFallbackToast
        );
      }
    }

    logger.warn(
      "Parakeet failed and no Whisper model is installed to retry with",
      { error: failure.message, code: failure.code || null },
      "transcription"
    );
    throw createToastError(`Parakeet failed: ${failure.message}`, noLocalFallbackToast);
  }

  // The user's own Whisper model when it is on disk, otherwise the smallest one
  // that is. Null when none is, or when the list cannot be read.
  async findFallbackWhisperModel() {
    let listing;
    try {
      listing = await window.electronAPI?.listWhisperModels?.();
    } catch (error) {
      logger.warn(
        "Could not list Whisper models for the Parakeet fallback",
        { error: error?.message },
        "transcription"
      );
      return null;
    }

    // small-en-tdrz is the speaker-turn model for files; the dictation picker hides it too.
    const downloaded = (Array.isArray(listing?.models) ? listing.models : []).filter(
      (entry) => entry?.downloaded && entry.model && entry.model !== "small-en-tdrz"
    );
    if (downloaded.length === 0) {
      return null;
    }

    const preferred = this.getTranscriptionSetting("whisperModel", "");
    if (preferred && downloaded.some((entry) => entry.model === preferred)) {
      return preferred;
    }

    const sizeOf = (entry) =>
      Number.isFinite(entry.size_bytes) ? entry.size_bytes : Number.POSITIVE_INFINITY;
    return [...downloaded].sort((left, right) => sizeOf(left) - sizeOf(right))[0].model;
  }

  isTranscriptionRequestCancelled(metadata = {}) {
    if (metadata?.source === "long-session") {
      return this.longSession?.cancelled === true;
    }
    if (metadata?.processingGeneration) {
      return !this.isCurrentProcessingGeneration(metadata.processingGeneration);
    }
    return false;
  }

  async getAPIKey() {
    // Get the current transcription provider
    const provider = this.getTranscriptionSetting("cloudTranscriptionProvider", "openai");

    // Check cache (invalidate if provider changed)
    if (this.cachedApiKey !== null && this.cachedApiKeyProvider === provider) {
      return this.cachedApiKey;
    }

    let apiKey = null;

    if (provider === "custom") {
      if (this.hasTranscriptionSettingSnapshot("customTranscriptionApiKey")) {
        apiKey = this.getTranscriptionSetting("customTranscriptionApiKey", "");
      } else {
        try {
          apiKey = await window.electronAPI.getCustomTranscriptionKey?.();
        } catch (err) {
          logger.debug(
            "Failed to get custom transcription key via IPC, falling back to localStorage",
            { error: err?.message },
            "transcription"
          );
        }
        if (!apiKey || !apiKey.trim()) {
          apiKey = localStorage.getItem("customTranscriptionApiKey") || "";
        }
      }
      apiKey = apiKey?.trim() || "";

      logger.debug(
        "Custom STT API key retrieval",
        {
          provider,
          hasKey: !!apiKey,
          keyLength: apiKey?.length || 0,
          keyPreview: apiKey ? "[configured]" : "(none)",
        },
        "transcription"
      );

      // For custom, we allow null/empty - the endpoint may not require auth
      if (!apiKey) {
        apiKey = null;
      }
    } else if (provider === "groq") {
      // Try to get Groq API key
      if (this.hasTranscriptionSettingSnapshot("groqApiKey")) {
        apiKey = this.getTranscriptionSetting("groqApiKey", "");
      } else {
        apiKey = await window.electronAPI.getGroqKey?.();
        if (!isValidApiKey(apiKey, "groq")) {
          apiKey = localStorage.getItem("groqApiKey");
        }
      }
      if (!isValidApiKey(apiKey, "groq")) {
        throw new Error("Groq API key not found. Please set your API key in the Control Panel.");
      }
    } else {
      // Default to OpenAI
      if (this.hasTranscriptionSettingSnapshot("openaiApiKey")) {
        apiKey = this.getTranscriptionSetting("openaiApiKey", "");
      } else {
        apiKey = await window.electronAPI.getOpenAIKey();
        if (!isValidApiKey(apiKey, "openai")) {
          apiKey = localStorage.getItem("openaiApiKey");
        }
      }
      if (!isValidApiKey(apiKey, "openai")) {
        throw new Error(
          "OpenAI API key not found. Please set your API key in the .env file or Control Panel."
        );
      }
    }

    this.cachedApiKey = apiKey;
    this.cachedApiKeyProvider = provider;
    return apiKey;
  }

  async optimizeAudio(audioBlob) {
    return new Promise((resolve) => {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const reader = new FileReader();

      reader.onload = async () => {
        try {
          const arrayBuffer = reader.result;
          const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

          // Convert to 16kHz mono for smaller size and faster upload
          const sampleRate = 16000;
          const channels = 1;
          const length = Math.floor(audioBuffer.duration * sampleRate);
          const offlineContext = new OfflineAudioContext(channels, length, sampleRate);

          const source = offlineContext.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(offlineContext.destination);
          source.start();

          const renderedBuffer = await offlineContext.startRendering();
          const wavBlob = this.audioBufferToWav(renderedBuffer);
          resolve(wavBlob);
        } catch (error) {
          // If optimization fails, use original
          resolve(audioBlob);
        }
      };

      reader.onerror = () => resolve(audioBlob);
      reader.readAsArrayBuffer(audioBlob);
    });
  }

  audioBufferToWav(buffer) {
    const length = buffer.length;
    const arrayBuffer = new ArrayBuffer(44 + length * 2);
    const view = new DataView(arrayBuffer);
    const sampleRate = buffer.sampleRate;
    const channelData = buffer.getChannelData(0);

    const writeString = (offset, string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(0, "RIFF");
    view.setUint32(4, 36 + length * 2, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, length * 2, true);

    let offset = 44;
    for (let i = 0; i < length; i++) {
      const sample = Math.max(-1, Math.min(1, channelData[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }

    return new Blob([arrayBuffer], { type: "audio/wav" });
  }

  async processWithReasoningModel(text, model, agentName, config = {}) {
    logger.logReasoning("CALLING_REASONING_SERVICE", {
      model,
      agentName,
      textLength: text.length,
      dictationMode: config.dictationMode || null,
    });

    const startTime = Date.now();

    try {
      const result = await ReasoningService.processText(text, model, agentName, config);

      const processingTime = Date.now() - startTime;

      logger.logReasoning("REASONING_SERVICE_COMPLETE", {
        model,
        processingTimeMs: processingTime,
        resultLength: result.length,
        success: true,
      });

      return result;
    } catch (error) {
      const processingTime = Date.now() - startTime;

      logger.logReasoning("REASONING_SERVICE_ERROR", {
        model,
        processingTimeMs: processingTime,
        error: error.message,
        stack: error.stack,
      });

      throw error;
    }
  }

  async isReasoningAvailable() {
    if (this.codingPromptSession) return false;
    if (typeof window === "undefined" || !window.localStorage) {
      return false;
    }

    if (
      typeof this._checkBetaFeatureAccess !== "function" ||
      !this._checkBetaFeatureAccess("ai-enhancement")
    ) {
      return false;
    }

    const storedValue = localStorage.getItem("useReasoningModel");
    const cacheKey = `${storedValue}:${localStorage.getItem("reasoningModel")}`;
    const now = Date.now();
    const cacheValid =
      this.reasoningAvailabilityCache &&
      now < this.reasoningAvailabilityCache.expiresAt &&
      this.cachedReasoningPreference === cacheKey;

    if (cacheValid) {
      return this.reasoningAvailabilityCache.value;
    }

    logger.logReasoning("REASONING_STORAGE_CHECK", {
      storedValue,
      typeOfStoredValue: typeof storedValue,
      isTrue: storedValue === "true",
      isTruthy: !!storedValue && storedValue !== "false",
    });

    const useReasoning = storedValue === "true" || (!!storedValue && storedValue !== "false");

    if (!useReasoning) {
      this.reasoningAvailabilityCache = {
        value: false,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = cacheKey;
      return false;
    }

    try {
      const isAvailable = await ReasoningService.isAvailable();

      logger.logReasoning("REASONING_AVAILABILITY", {
        isAvailable,
        reasoningEnabled: useReasoning,
        finalDecision: useReasoning && isAvailable,
      });

      this.reasoningAvailabilityCache = {
        value: isAvailable,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = cacheKey;

      return isAvailable;
    } catch (error) {
      logger.logReasoning("REASONING_AVAILABILITY_ERROR", {
        error: error.message,
        stack: error.stack,
      });

      this.reasoningAvailabilityCache = {
        value: false,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = cacheKey;
      return false;
    }
  }

  /**
   * Repair casing and accidental splits for custom dictionary terms in raw STT output.
   *
   * This is a spelling repair, not a mishearing repair. It matches the term
   * case-insensitively on whole-word boundaries and rewrites it with the casing
   * stored in the dictionary, so "privatetranscribe" and "OpenC ode" are fixed
   * but a genuine mishearing like "provoca" is not - the letters have to already
   * be right. Mishearings are handled by Correction Memory, which stores an
   * explicit heard-this / write-that pair.
   *
   * Runs for every dictionary term. Whole-word only, so "unprovocative" is untouched.
   */
  applyDictionaryReplacements(text) {
    try {
      const raw = localStorage.getItem("customDictionary");
      if (!raw) return text;
      const words = JSON.parse(raw);
      if (!Array.isArray(words) || words.length === 0) return text;
      const repairWords = words.filter((word) => typeof word === "string" && word.trim());
      if (repairWords.length === 0) return text;

      let result = repairSplitDictionaryTerms(text, repairWords);
      for (const word of repairWords) {
        // Escape special regex chars in the dictionary word, then match whole-word, case-insensitive
        const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`\\b${escaped}\\b`, "gi");
        result = result.replace(regex, word);
      }
      return result;
    } catch {
      return text;
    }
  }

  async processTranscription(text, source) {
    const rawInputText = typeof text === "string" ? text.trim() : "";
    const withDictionary = this.applyDictionaryReplacements(rawInputText);
    const normalizedText = normalizePunctuationSpacing(withDictionary);

    logger.logReasoning("TRANSCRIPTION_RECEIVED", {
      source,
      textLength: normalizedText.length,
      rawInputPreview: rawInputText.substring(0, 200) + (rawInputText.length > 200 ? "..." : ""),
      normalizedPreview:
        normalizedText.substring(0, 200) + (normalizedText.length > 200 ? "..." : ""),
      timestamp: new Date().toISOString(),
    });
    emitTranscriptionTextTrace("PIPELINE", {
      source,
      raw: rawInputText,
      normalized: normalizedText,
      dictionaryChanged: withDictionary !== rawInputText,
      punctuationChanged: normalizedText !== withDictionary,
    });

    const reasoningModel =
      typeof window !== "undefined" && window.localStorage
        ? localStorage.getItem("reasoningModel") || ""
        : "";
    const reasoningProvider =
      typeof window !== "undefined" && window.localStorage
        ? localStorage.getItem("reasoningProvider") || "auto"
        : "auto";
    const agentName =
      typeof window !== "undefined" && window.localStorage
        ? localStorage.getItem("agentName") || null
        : null;
    // Active dictation mode set by an Action Engine "dictation-mode" action.
    // Persisted to localStorage so this plain-JS class can read it without
    // requiring React state to be threaded down.
    const dictationMode =
      typeof window !== "undefined" && window.localStorage && areExperimentalFeaturesEnabled()
        ? localStorage.getItem("activeDictationMode") || undefined
        : undefined;
    // User's preferred output language (BCP-47, e.g. "en"). Passed to the
    // reasoning service so it can instruct the LLM to output in the correct
    // language even when the transcription engine auto-detected the wrong one.
    const preferredLanguage =
      typeof window !== "undefined" && window.localStorage
        ? localStorage.getItem("preferredLanguage") || null
        : null;
    if (!reasoningModel) {
      logger.logReasoning("REASONING_SKIPPED", {
        reason: "No reasoning model selected",
      });
      emitTranscriptionTextTrace("FINAL", {
        source,
        final: normalizedText,
        reasoningUsed: false,
        reason: "No reasoning model selected",
      });
      return normalizedText;
    }

    const useReasoning = await this.isReasoningAvailable();

    logger.logReasoning("REASONING_CHECK", {
      useReasoning,
      reasoningModel,
      reasoningProvider,
      agentName,
      dictationMode: dictationMode || null,
      preferredLanguage: preferredLanguage || null,
    });

    if (useReasoning) {
      try {
        logger.logReasoning("SENDING_TO_REASONING", {
          preparedTextLength: normalizedText.length,
          model: reasoningModel,
          provider: reasoningProvider,
          dictationMode: dictationMode || null,
          preferredLanguage: preferredLanguage || null,
        });

        const result = await this.processWithReasoningModel(
          normalizedText,
          reasoningModel,
          agentName,
          {
            dictationMode,
            preferredLanguage,
            writingStyle:
              localStorage.getItem("enhancementWritingStyle") === "coding" ? "coding" : "clean",
            smartContext: this._cachedSmartContext ?? null,
          }
        );

        logger.logReasoning("REASONING_SUCCESS", {
          resultLength: result.length,
          resultPreview: result.substring(0, 100) + (result.length > 100 ? "..." : ""),
          processingTime: new Date().toISOString(),
        });

        const finalText = normalizePunctuationSpacing(result);
        emitTranscriptionTextTrace("FINAL", {
          source,
          final: finalText,
          reasoningUsed: true,
          reasoningChanged: finalText !== normalizedText,
        });
        return finalText;
      } catch (error) {
        logger.logReasoning("REASONING_FAILED", {
          error: error.message,
          stack: error.stack,
          fallbackToCleanup: true,
        });
        console.error(`Reasoning failed (${source}):`, error.message);
      }
    }

    logger.logReasoning("USING_STANDARD_CLEANUP", {
      reason: useReasoning ? "Reasoning failed" : "Reasoning not enabled",
    });

    emitTranscriptionTextTrace("FINAL", {
      source,
      final: normalizedText,
      reasoningUsed: false,
      reason: useReasoning ? "Reasoning failed" : "Reasoning not enabled",
    });
    return normalizedText;
  }

  shouldStreamTranscription(model, provider) {
    if (provider !== "openai") {
      return false;
    }
    const normalized = typeof model === "string" ? model.trim() : "";
    if (!normalized || normalized === "whisper-1") {
      return false;
    }
    if (normalized === "gpt-transcribe") {
      return true;
    }
    if (normalized === "gpt-4o-transcribe" || normalized === "gpt-4o-transcribe-diarize") {
      return true;
    }
    return normalized.startsWith("gpt-4o-mini-transcribe");
  }

  async readTranscriptionStream(response) {
    const reader = response.body?.getReader();
    if (!reader) {
      logger.error("Streaming response body not available", {}, "transcription");
      throw new Error("Streaming response body not available");
    }

    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let collectedText = "";
    let finalText = null;
    let eventCount = 0;
    const eventTypes = {};

    const handleEvent = (payload) => {
      if (!payload || typeof payload !== "object") {
        return;
      }
      eventCount++;
      const eventType = payload.type || "unknown";
      eventTypes[eventType] = (eventTypes[eventType] || 0) + 1;

      logger.debug(
        "Stream event received",
        {
          type: eventType,
          eventNumber: eventCount,
          payloadKeys: Object.keys(payload),
        },
        "transcription"
      );

      if (payload.type === "transcript.text.delta" && typeof payload.delta === "string") {
        collectedText += payload.delta;
        return;
      }
      if (payload.type === "transcript.text.segment" && typeof payload.text === "string") {
        collectedText += payload.text;
        return;
      }
      if (payload.type === "transcript.text.done" && typeof payload.text === "string") {
        finalText = payload.text;
        logger.debug(
          "Final transcript received",
          {
            textLength: payload.text.length,
          },
          "transcription"
        );
      }
    };

    const processStreamLine = (line) => {
      const trimmedLine = line.trim();

      // Skip empty lines
      if (!trimmedLine) {
        return;
      }

      // Extract data from "data: " prefix
      let data = "";
      if (trimmedLine.startsWith("data: ")) {
        data = trimmedLine.slice(6);
      } else if (trimmedLine.startsWith("data:")) {
        data = trimmedLine.slice(5).trim();
      } else {
        // Not a data line, could be leftover - keep in buffer
        buffer += line + "\n";
        return;
      }

      // Handle [DONE] marker
      if (data === "[DONE]") {
        finalText = finalText ?? collectedText;
        return;
      }

      // Try to parse JSON
      try {
        const parsed = JSON.parse(data);
        handleEvent(parsed);
      } catch (error) {
        // Incomplete JSON - put back in buffer for next iteration
        buffer = `${line}\n${buffer}`;
      }
    };

    logger.debug("Starting to read transcription stream", {}, "transcription");

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        const finalDecoderChunk = decoder.decode();
        if (finalDecoderChunk) {
          buffer += finalDecoderChunk;
        }
        if (buffer.trim()) {
          const finalLines = buffer.split(/\r?\n/);
          buffer = "";
          for (const line of finalLines) {
            processStreamLine(line);
          }
        }

        logger.debug(
          "Stream reading complete",
          {
            eventCount,
            eventTypes,
            collectedTextLength: collectedText.length,
            hasFinalText: finalText !== null,
          },
          "transcription"
        );
        break;
      }
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;

      // Log first chunk to see format
      if (eventCount === 0 && chunk.length > 0) {
        logger.debug(
          "First stream chunk received",
          {
            chunkLength: chunk.length,
            chunkPreview: chunk.substring(0, 500),
          },
          "transcription"
        );
      }

      // Process complete lines from the buffer. Keep the trailing partial line
      // for the next read; stream chunks can split anywhere, including inside
      // the "data:" prefix or JSON payload.
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        processStreamLine(line);
      }
    }

    const result = finalText ?? collectedText;
    logger.debug(
      "Stream processing complete",
      {
        resultLength: result.length,
        usedFinalText: finalText !== null,
        eventCount,
        eventTypes,
      },
      "transcription"
    );

    return result;
  }

  async processWithOpenAIAPI(audioBlob, metadata = {}) {
    const timings = {};
    const language = metadata?.language ?? this.getTranscriptionSetting("preferredLanguage", "");
    const allowLocalFallback =
      this.getTranscriptionSetting("allowLocalFallback", "false") === "true";
    const fallbackModel = this.getTranscriptionSetting("fallbackWhisperModel", "base");
    const source = metadata?.source || "dictation";
    const originalFileName = metadata?.originalFileName || null;
    const skipOptimizationByMetadata = metadata?.skipOptimization === true;
    const processingGeneration = metadata?.processingGeneration ?? null;
    const abortController = new AbortController();
    if (processingGeneration !== null && processingGeneration !== undefined) {
      this.setActiveTranscriptionAbortController(abortController, processingGeneration);
    }

    try {
      const durationSeconds = metadata.durationSeconds ?? null;
      const shouldSkipOptimizationForDuration =
        typeof durationSeconds === "number" &&
        durationSeconds > 0 &&
        durationSeconds < SHORT_CLIP_DURATION_SECONDS;

      const model = this.getTranscriptionModel();
      const provider = this.getTranscriptionSetting("cloudTranscriptionProvider", "openai");

      const effectiveLanguage = !language || language === "auto" ? null : language;
      logger.info(
        "Language resolved for cloud transcription",
        {
          preferredLanguage: language || "(not set)",
          effectiveLanguage: effectiveLanguage || "(auto-detect)",
          fallbackToAuto: !!language && language !== "auto" && !effectiveLanguage,
          provider,
          model,
        },
        "transcription"
      );

      logger.debug(
        "Transcription request starting",
        {
          provider,
          model,
          source,
          originalFileName,
          blobSize: audioBlob.size,
          blobType: audioBlob.type,
          durationSeconds,
          language,
        },
        "transcription"
      );

      // gpt-4o-transcribe models don't support WAV format - they need webm, mp3, mp4, etc.
      // Only use WAV optimization for whisper-1 and groq models
      const is4oModel = model.includes("gpt-4o");
      const shouldOptimize =
        !is4oModel &&
        !shouldSkipOptimizationForDuration &&
        !skipOptimizationByMetadata &&
        audioBlob.size > 1024 * 1024;

      logger.debug(
        "Audio optimization decision",
        {
          is4oModel,
          shouldOptimize,
          shouldSkipOptimizationForDuration,
          skipOptimizationByMetadata,
        },
        "transcription"
      );

      const [apiKey, optimizedAudio] = await Promise.all([
        this.getAPIKey(),
        shouldOptimize ? this.optimizeAudio(audioBlob) : Promise.resolve(audioBlob),
      ]);

      const formData = new FormData();
      const mimeType = optimizedAudio.type || "audio/webm";
      const extension = resolveUploadExtension(originalFileName, mimeType);
      const uploadFileName = resolveUploadFileName(originalFileName, mimeType);

      logger.debug(
        "FormData preparation",
        {
          mimeType,
          extension,
          uploadFileName,
          optimizedSize: optimizedAudio.size,
          hasApiKey: !!apiKey,
        },
        "transcription"
      );

      formData.append("file", optimizedAudio, uploadFileName);
      formData.append("model", model);

      if (language && language !== "auto") {
        // GPT Transcribe replaces the legacy singular `language` field with
        // one or more `languages[]` hints. Sending both fields is rejected.
        if (model === "gpt-transcribe") {
          formData.append("languages[]", language);
        } else {
          formData.append("language", language);
        }
      }

      // Add custom dictionary as prompt hint for cloud transcription
      const dictionaryPrompt = this.getCustomDictionaryPrompt();
      if (dictionaryPrompt) {
        formData.append("prompt", dictionaryPrompt);
      }

      const shouldStream = this.shouldStreamTranscription(model, provider);
      if (shouldStream) {
        formData.append("stream", "true");
      }

      const endpoint = this.getTranscriptionEndpoint();
      const isCustomEndpoint =
        provider === "custom" ||
        (!endpoint.includes("api.openai.com") && !endpoint.includes("api.groq.com"));

      logger.debug(
        "Making transcription API request",
        {
          endpoint,
          shouldStream,
          model,
          provider,
          source,
          isCustomEndpoint,
          hasApiKey: !!apiKey,
          apiKeyPreview: apiKey ? "[configured]" : "(none)",
        },
        "transcription"
      );

      // Build headers - only include Authorization if we have an API key
      const headers = {};
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }

      logger.debug(
        "STT request details",
        {
          endpoint,
          method: "POST",
          hasAuthHeader: !!apiKey,
          formDataFields: [
            "file",
            "model",
            language && language !== "auto"
              ? model === "gpt-transcribe"
                ? "languages[]"
                : "language"
              : null,
            shouldStream ? "stream" : null,
          ].filter(Boolean),
        },
        "transcription"
      );

      const apiCallStart = performance.now();
      abortController.signal.throwIfAborted();
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: formData,
        signal: abortController.signal,
      });

      const responseContentType = response.headers.get("content-type") || "";

      logger.debug(
        "Transcription API response received",
        {
          status: response.status,
          statusText: response.statusText,
          contentType: responseContentType,
          ok: response.ok,
        },
        "transcription"
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(
          "Transcription API error response",
          {
            status: response.status,
            errorText,
          },
          "transcription"
        );
        throw new Error(`API Error: ${response.status} ${errorText}`);
      }

      let result;
      const contentType = responseContentType;

      if (shouldStream && contentType.includes("text/event-stream")) {
        logger.debug("Processing streaming response", { contentType }, "transcription");
        const streamedText = await this.readTranscriptionStream(response);
        result = { text: streamedText };
        logger.debug(
          "Streaming response parsed",
          {
            hasText: !!streamedText,
            textLength: streamedText?.length,
          },
          "transcription"
        );
      } else {
        const rawText = await response.text();
        logger.debug(
          "Raw API response body",
          {
            rawText: rawText.substring(0, 1000),
            fullLength: rawText.length,
          },
          "transcription"
        );

        try {
          result = JSON.parse(rawText);
        } catch (parseError) {
          logger.error(
            "Failed to parse JSON response",
            {
              parseError: parseError.message,
              rawText: rawText.substring(0, 500),
            },
            "transcription"
          );
          throw new Error(`Failed to parse API response: ${parseError.message}`);
        }

        logger.debug(
          "Parsed transcription result",
          {
            hasText: !!result.text,
            textLength: result.text?.length,
            resultKeys: Object.keys(result),
            fullResult: result,
          },
          "transcription"
        );
      }

      // Check for text - handle both empty string and missing field
      if (result.text && result.text.trim().length > 0) {
        timings.transcriptionProcessingDurationMs = Math.round(performance.now() - apiCallStart);

        if (metadata?.skipPostProcessing) {
          return { success: true, text: result.text, source: "openai", timings };
        }

        const reasoningStart = performance.now();
        const text = await this.processTranscription(result.text, "openai");
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        const source = (await this.isReasoningAvailable()) ? "openai-reasoned" : "openai";
        logger.debug(
          "Transcription successful",
          {
            originalLength: result.text.length,
            processedLength: text.length,
            source,
            transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
            reasoningProcessingDurationMs: timings.reasoningProcessingDurationMs,
          },
          "transcription"
        );
        return { success: true, text, source, timings };
      } else {
        // Log at info level so it shows without debug mode
        logger.info(
          "Transcription returned empty - check audio input",
          {
            model,
            provider,
            endpoint,
            blobSize: audioBlob.size,
            blobType: audioBlob.type,
            mimeType,
            extension,
            resultText: result.text,
            resultKeys: Object.keys(result),
          },
          "transcription"
        );
        logger.error(
          "No text in transcription result",
          {
            result,
            resultKeys: Object.keys(result),
          },
          "transcription"
        );
        throw new Error(
          "No text transcribed - audio may be too short, silent, or in an unsupported format"
        );
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        throw error;
      }

      const isOpenAIMode = this.getTranscriptionSetting("useLocalWhisper", "false") !== "true";

      if (allowLocalFallback && isOpenAIMode) {
        try {
          const arrayBuffer = toIpcSafeArrayBuffer(await audioBlob.arrayBuffer());
          abortController.signal.throwIfAborted();
          const options = {
            model: fallbackModel,
          };
          if (typeof processingGeneration === "string" && processingGeneration) {
            options.jobId = processingGeneration;
          }
          if (language && language !== "auto") {
            options.language = language;
          } else {
            options.allowedLanguages = readSpokenLanguages();
          }
          if (originalFileName) {
            options.inputFileName = originalFileName;
          }

          const localFallbackStart = performance.now();
          const result = await window.electronAPI.transcribeLocalWhisper(arrayBuffer, options);
          abortController.signal.throwIfAborted();
          if (result?.cancelled) {
            const cancellation = new Error("Transcription cancelled");
            cancellation.name = "AbortError";
            throw cancellation;
          }
          timings.transcriptionProcessingDurationMs = Math.round(
            performance.now() - localFallbackStart
          );
          if (Number.isFinite(result?.inferenceDurationMs) && result.inferenceDurationMs > 0) {
            timings.transcriptionInferenceDurationMs = Math.round(result.inferenceDurationMs);
          }

          if (result.success && result.text) {
            if (metadata?.skipPostProcessing) {
              return {
                success: true,
                text: result.text,
                source: "local-fallback",
                timings,
                computeMode: result.computeMode,
              };
            }

            const text = await this.processTranscription(result.text, "local-fallback");
            if (text) {
              return {
                success: true,
                text,
                source: "local-fallback",
                timings,
                computeMode: result.computeMode,
              };
            }
          }
          throw error;
        } catch (fallbackError) {
          if (fallbackError?.name === "AbortError") {
            throw fallbackError;
          }
          throw new Error(
            `OpenAI API failed: ${error.message}. Local fallback also failed: ${fallbackError.message}`
          );
        }
      }

      throw error;
    } finally {
      this.clearActiveTranscriptionAbortController(processingGeneration);
    }
  }

  async processFileTranscriptionV2(audioBlob, model = "base", metadata = {}) {
    const arrayBuffer = toIpcSafeArrayBuffer(await audioBlob.arrayBuffer());
    const rawLanguage = metadata.language ?? this.getTranscriptionSetting("preferredLanguage", "");
    const translateToEnglishSetting =
      metadata.translate === true ||
      this.getTranscriptionSetting("translateToEnglish", "off") === "on"
        ? "on"
        : "off";
    const resolvedLanguage = resolveTranscriptionLanguage(rawLanguage, "whisper", model);
    const options = {
      model,
      fileMode: true,
      noiseReduction: metadata.noiseReduction !== false,
      speakerDetection: metadata.speakerDetection === true,
      speakerDetectionMode: metadata.speakerDetectionMode,
      expectedSpeakers: metadata.expectedSpeakers,
      diarizationThreshold: metadata.diarizationThreshold,
      outputFormat: metadata.outputFormat || "plain",
      inputFileName: metadata.originalFileName,
    };
    // The handle the caller cancels with. Passed down rather than invented in
    // the main process, so the page can stop a run it started before the first
    // result has come back.
    if (metadata.jobId) {
      options.jobId = metadata.jobId;
    }
    if (resolvedLanguage) {
      options.language = resolvedLanguage;
    } else {
      options.allowedLanguages = readSpokenLanguages();
    }
    if (
      shouldTranslateLocalWhisperToEnglish({
        translateToEnglish: translateToEnglishSetting,
        resolvedLanguage,
        model,
      })
    ) {
      options.translate = true;
    }
    const result = await window.electronAPI.transcribeFileV2(arrayBuffer, options);
    if (result?.success && result.text) {
      return { success: true, ...result, source: "local-file-v2" };
    }
    // Cancelling is not an error. Handed back as an outcome so the caller can
    // return to idle instead of rendering a failure the user caused on purpose.
    if (result?.cancelled) {
      return { success: false, cancelled: true, jobId: result.jobId, source: "local-file-v2" };
    }
    throw new Error(result?.message || result?.error || "Local file transcription failed");
  }

  getTranscriptionModel() {
    try {
      const provider = this.getTranscriptionSetting("cloudTranscriptionProvider", "openai");
      const model = this.getTranscriptionSetting("cloudTranscriptionModel", "");

      const trimmedModel = model.trim();

      // For custom provider, use whatever model is set (or fallback to whisper-1)
      if (provider === "custom") {
        return trimmedModel || "whisper-1";
      }

      // Validate model matches provider to handle settings migration
      if (trimmedModel) {
        const isGroqModel = trimmedModel.startsWith("whisper-large-v3");
        const isOpenAIModel =
          trimmedModel === "gpt-transcribe" ||
          trimmedModel.startsWith("gpt-4o") ||
          trimmedModel === "whisper-1";

        if (provider === "groq" && isGroqModel) {
          return trimmedModel;
        }
        if (provider === "openai" && isOpenAIModel) {
          return trimmedModel;
        }
        // Model doesn't match provider - fall through to default
      }

      // Return provider-appropriate default
      return provider === "groq" ? "whisper-large-v3-turbo" : "gpt-transcribe";
    } catch (error) {
      return "gpt-transcribe";
    }
  }

  getTranscriptionEndpoint() {
    // Get current provider and base URL to check if cache is valid
    const currentProvider = this.getTranscriptionSetting("cloudTranscriptionProvider", "openai");
    const currentBaseUrl = this.getTranscriptionSetting("cloudTranscriptionBaseUrl", "");

    // Only use custom URL when provider is explicitly "custom"
    const isCustomEndpoint = currentProvider === "custom";

    // Invalidate cache if provider or base URL changed
    if (
      this.cachedTranscriptionEndpoint &&
      (this.cachedEndpointProvider !== currentProvider ||
        this.cachedEndpointBaseUrl !== currentBaseUrl)
    ) {
      logger.debug(
        "STT endpoint cache invalidated",
        {
          previousProvider: this.cachedEndpointProvider,
          newProvider: currentProvider,
          previousBaseUrl: this.cachedEndpointBaseUrl,
          newBaseUrl: currentBaseUrl,
        },
        "transcription"
      );
      this.cachedTranscriptionEndpoint = null;
    }

    if (this.cachedTranscriptionEndpoint) {
      return this.cachedTranscriptionEndpoint;
    }

    try {
      // Use custom URL only when provider is "custom", otherwise use provider-specific defaults
      let base;
      if (isCustomEndpoint) {
        base = currentBaseUrl.trim() || API_ENDPOINTS.TRANSCRIPTION_BASE;
      } else if (currentProvider === "groq") {
        base = API_ENDPOINTS.GROQ_BASE;
      } else {
        // OpenAI or other standard providers
        base = API_ENDPOINTS.TRANSCRIPTION_BASE;
      }

      const normalizedBase = normalizeBaseUrl(base);

      logger.debug(
        "STT endpoint resolution",
        {
          provider: currentProvider,
          isCustomEndpoint,
          rawBaseUrl: currentBaseUrl,
          normalizedBase,
          defaultBase: API_ENDPOINTS.TRANSCRIPTION_BASE,
        },
        "transcription"
      );

      const cacheResult = (endpoint) => {
        this.cachedTranscriptionEndpoint = endpoint;
        this.cachedEndpointProvider = currentProvider;
        this.cachedEndpointBaseUrl = currentBaseUrl;

        logger.debug(
          "STT endpoint resolved",
          {
            endpoint,
            provider: currentProvider,
            isCustomEndpoint,
            usingDefault: endpoint === API_ENDPOINTS.TRANSCRIPTION,
          },
          "transcription"
        );

        return endpoint;
      };

      if (!normalizedBase) {
        logger.debug(
          "STT endpoint: using default (normalization failed)",
          { rawBase: base },
          "transcription"
        );
        return cacheResult(API_ENDPOINTS.TRANSCRIPTION);
      }

      // Only validate HTTPS for custom endpoints (known providers are already HTTPS)
      if (isCustomEndpoint && !isSecureEndpoint(normalizedBase)) {
        logger.warn(
          "STT endpoint: HTTPS required, falling back to default",
          { attemptedUrl: normalizedBase },
          "transcription"
        );
        return cacheResult(API_ENDPOINTS.TRANSCRIPTION);
      }

      let endpoint;
      if (/\/audio\/(transcriptions|translations)$/i.test(normalizedBase)) {
        endpoint = normalizedBase;
        logger.debug("STT endpoint: using full path from config", { endpoint }, "transcription");
      } else {
        endpoint = buildApiUrl(normalizedBase, "/audio/transcriptions");
        logger.debug(
          "STT endpoint: appending /audio/transcriptions to base",
          { base: normalizedBase, endpoint },
          "transcription"
        );
      }

      return cacheResult(endpoint);
    } catch (error) {
      logger.error(
        "STT endpoint resolution failed",
        { error: error.message, stack: error.stack },
        "transcription"
      );
      this.cachedTranscriptionEndpoint = API_ENDPOINTS.TRANSCRIPTION;
      this.cachedEndpointProvider = currentProvider;
      this.cachedEndpointBaseUrl = currentBaseUrl;
      return API_ENDPOINTS.TRANSCRIPTION;
    }
  }

  /**
   * Preserve dispatch separately from text observation. Browser editors can
   * accept a paste while their accessible text remains unchanged or stale.
   */
  async safePaste(text, options = {}) {
    try {
      const result = await window.electronAPI.pasteText(text, options);
      return {
        delivered: result?.delivered !== false,
        evidence: result?.evidence ?? null,
        dispatched: result?.dispatched === true,
        clipboardPreserved: result?.clipboardPreserved === true,
      };
    } catch (error) {
      this.onError?.({
        title: "Paste Error",
        description: `Failed to paste text. Please check accessibility permissions. ${error.message}`,
      });
      return { delivered: false, evidence: "absent" };
    }
  }

  async saveTranscription(text, durationSeconds = null) {
    try {
      const result = await window.electronAPI.saveTranscription(text, durationSeconds);
      return result?.success === true;
    } catch {
      return false;
    }
  }

  async recordTranscriptionActivity(text, durationSeconds = null) {
    try {
      const result = await window.electronAPI.recordTranscriptionActivity?.(text, durationSeconds);
      return result?.success === true;
    } catch {
      return false;
    }
  }

  getState() {
    return {
      isRecording: this.isRecording,
      isProcessing: this.isProcessing,
      isStartingRecording: this.isStartingRecording,
      isStoppingRecording: this.isStoppingRecording,
      longSession: this.getLongSessionSnapshot(),
    };
  }

  cleanup() {
    this.abortActiveTranscriptionRequest();
    this.processingGeneration += 1;
    this.cancelLongSessionWork();
    this.transcriptionSettingsChangedCleanup?.();
    this.transcriptionSettingsChangedCleanup = null;
    this.transcriptionSettingsSnapshot = null;
    this.invalidateTranscriptionRuntimeCaches();
    this.discardCurrentRecording = true;
    this.clearRecorderStopWatchdog();
    if (this.mediaRecorder?.state === "recording") {
      try {
        this.mediaRecorder.stop();
      } catch {
        // Ignore stop errors during teardown.
      }
    }

    this.releaseMediaRecorder();
    this.audioChunks = [];
    this.recordingChunkDurationsMs = [];
    this.lastRecorderDataAt = null;
    this.recordingStartTime = null;
    this.isRecording = false;
    this.isProcessing = false;
    this.isStartingRecording = false;
    this.isStoppingRecording = false;
    this.pendingStopAfterStart = false;
    this.pendingCancelAfterStart = false;
    this.discardCurrentRecording = false;
    this.resetLongSessionState();
    this.onStateChange = null;
    this.onError = null;
    this.onTranscriptionComplete = null;
    // Force-release the warm mic stream on teardown. Otherwise the "always ready" setting
    // (no release timer) would leave the device open after the window/manager is gone.
    this._clearPooledStream();
    if (typeof navigator !== "undefined" && navigator.mediaDevices && this._deviceChangeHandler) {
      navigator.mediaDevices.removeEventListener("devicechange", this._deviceChangeHandler);
      this._deviceChangeHandler = null;
    }
    this._systemResumedCleanup?.();
    this._systemResumedCleanup = null;
  }
}

export default AudioManager;
