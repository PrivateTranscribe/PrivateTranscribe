import ReasoningService from "../services/ReasoningService";
import { API_ENDPOINTS, buildApiUrl, normalizeBaseUrl } from "../config/constants";
import logger from "../utils/logger";
import { resolveMicWarmWindowMs } from "../utils/micWarmWindow";
import { isBuiltInMicrophone } from "../utils/audioDeviceUtils";
import { isSecureEndpoint } from "../utils/urlUtils";
import { resolveTranscriptionLanguage } from "../utils/languageCompat";
import { repairSplitDictionaryTerms } from "../utils/transcriptionTextRepair";
import { assessTranscriptionCompleteness } from "../utils/transcriptionCompleteness";
import {
  buildDictionaryPrompt,
  getDictionaryRepairTerms,
  parseDictionaryEntryModes,
} from "../utils/dictionaryEntryModes";
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
const LONG_SESSION_CHUNK_MAX_ATTEMPTS = 2;

const isTranscriptionTextDebugEnabled = () => {
  try {
    if (typeof window === "undefined" || !window.localStorage) return false;
    const value = window.localStorage.getItem("debugTranscriptionText");
    return value === "on" || value === "true" || value === "1";
  } catch {
    return false;
  }
};

const previewText = (value, limit = 500) => {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
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
    this.longSession = this.createLongSessionState();
    this.longSessionSegment = null;
    this.longSessionPromotionUnavailable = false;
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
    this.recoveryIdsByGeneration = new Map();
    this._cachedSmartContext = null;
    this._checkBetaFeatureAccess = null;
    this._deviceChangeHandler = null;

    // Pre-warm device cache and keep it fresh
    if (navigator.mediaDevices) {
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
      const modes = parseDictionaryEntryModes(localStorage.getItem("dictionaryEntryModes"));
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
      const unique = [...new Set(words.filter(Boolean))];
      return buildDictionaryPrompt(unique, modes);
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
        // Only include corrections used more than once (higher confidence)
        this._cachedCorrectionHints = corrections
          .filter((r) => r?.target && (r?.count || 0) >= 2)
          .map((r) => r.target);
      }
    } catch {
      // ignore
    }
  }

  setCallbacks({ onStateChange, onError, onTranscriptionComplete }) {
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.onTranscriptionComplete = onTranscriptionComplete;
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
      errors: [],
      recoveryIds: new Set(),
      failedRecoveryIds: new Set(),
      processing: false,
      processingPromise: null,
      sessionId: 0,
      nextChunkIndex: 0,
      queuedChunks: 0,
      completedChunks: 0,
      recordedSeconds: 0,
      transcribedSeconds: 0,
      promotedAt: null,
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
    for (const recoveryId of this.longSession.recoveryIds || []) {
      void this.markDictationRecoveryCanceled(recoveryId);
    }
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

  isRecoveryEnabled() {
    try {
      const historyLimit = parseInt(localStorage.getItem("historyLimit") ?? "50", 10);
      return historyLimit !== 0 && !!window.electronAPI?.stageDictationRecovery;
    } catch {
      return false;
    }
  }

  async stageDictationRecovery(audioBlob, metadata = {}) {
    if (!this.isRecoveryEnabled() || !audioBlob || audioBlob.size <= 0) {
      return null;
    }
    try {
      const response = await window.electronAPI.stageDictationRecovery(
        toIpcSafeArrayBuffer(await audioBlob.arrayBuffer()),
        {
          mimeType: audioBlob.type || "audio/webm",
          durationSeconds: metadata.durationSeconds ?? null,
        }
      );
      return response?.success && response?.recovery?.id ? response.recovery.id : null;
    } catch (error) {
      logger.warn("Failed to stage dictation recovery audio", { error: error?.message }, "audio");
      return null;
    }
  }

  async markDictationRecoveryFailed(id, reason) {
    if (!id) return;
    try {
      await window.electronAPI?.markDictationRecoveryFailed?.(id, reason);
    } catch {
      // The staged pending entry remains recoverable after a metadata update failure.
    }
  }

  async markDictationRecoveryCanceled(id) {
    if (!id) return;
    try {
      await window.electronAPI?.markDictationRecoveryCanceled?.(id);
    } catch {
      // The staged pending entry remains recoverable after a metadata update failure.
    }
  }

  async completeDictationRecovery(id) {
    if (!id) return;
    try {
      await window.electronAPI?.completeDictationRecovery?.(id);
    } catch {
      // A completed entry may remain until bounded pruning; never risk deleting another entry.
    }
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
      if (this.longSessionSegment) {
        return;
      }

      this.enqueueLongSessionChunk(data, durationMs);
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
          void this.rotateLongSessionSegment();
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
      this.enqueueLongSessionChunk(
        new Blob(segment.chunks, { type: segment.recorder.mimeType || this.recordingMimeType }),
        durationMs,
        { trimTrailingSilence: !segment.restartAfterStop }
      );
    } else if (segment.discard && segment.chunks.length > 0) {
      const canceledAudio = new Blob(segment.chunks, {
        type: segment.recorder.mimeType || this.recordingMimeType,
      });
      void (async () => {
        const recoveryId = await this.stageDictationRecovery(canceledAudio, {
          durationSeconds: durationMs / 1000,
        });
        await this.markDictationRecoveryCanceled(recoveryId);
      })();
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
          if (!item.recoveryStaged) {
            item.recoveryStaged = true;
            item.recoveryId = await this.stageDictationRecovery(item.blob, {
              durationSeconds: item.durationMs / 1000,
            });
            if (item.recoveryId) {
              state.recoveryIds.add(item.recoveryId);
            }
          }
          item.attempts += 1;
          const result = await this.runTranscription(item.blob, {
            durationSeconds: item.durationMs / 1000,
            source: "long-session",
            skipPostProcessing: true,
            skipOptimization: true,
            chunkIndex: item.index,
            trimTrailingSilence: item.trimTrailingSilence,
          });

          const text = String(result?.result?.text || "").trim();
          if (text) {
            state.results.set(item.index, text);
          }
          state.completedChunks += 1;
          state.transcribedSeconds += item.durationMs / 1000;
        } catch (error) {
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
            continue;
          }

          state.errors.push({
            index: item.index,
            message: error?.message || "Chunk transcription failed",
          });
          if (item.recoveryId) {
            state.failedRecoveryIds.add(item.recoveryId);
          }
          await this.markDictationRecoveryFailed(
            item.recoveryId,
            error?.message || "Chunk transcription failed"
          );
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

  async finalizeLongSessionResult(durationSeconds) {
    await this.waitForLongSessionQueue();

    const state = this.longSession;
    if (state.errors.length > 0) {
      throw new Error(
        `Long recording could not be transcribed completely after retrying chunk ${state.errors[0].index + 1}: ${state.errors[0].message}`
      );
    }

    const rawText = [...state.results.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, text]) => text)
      .filter(Boolean)
      .join(" ")
      .trim();

    if (!rawText) {
      throw new Error("No text transcribed - audio may be silent or unavailable");
    }

    const reasoningStart = performance.now();
    const text = await this.processTranscription(rawText, "long-session");
    const source = (await this.isReasoningAvailable()) ? "long-session-reasoned" : "long-session";

    return {
      success: true,
      text: text || rawText,
      source,
      durationSeconds,
      timings: {
        reasoningProcessingDurationMs: Math.round(performance.now() - reasoningStart),
      },
      longSession: {
        chunks: state.completedChunks,
        failedChunks: state.errors.length,
      },
    };
  }

  stopRecordingStream() {
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
      if (audioBlob?.size > 0) {
        const recoveryId = await this.stageDictationRecovery(audioBlob, { durationSeconds });
        await this.markDictationRecoveryCanceled(recoveryId);
      }
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

    await this.processAudio(audioBlob, { durationSeconds });
    return true;
  }

  async getAudioConstraints() {
    const preferBuiltIn = localStorage.getItem("preferBuiltInMic") !== "false";
    const selectedDeviceId = localStorage.getItem("selectedMicDeviceId") || "";

    if (preferBuiltIn) {
      try {
        const audioInputs =
          this._cachedAudioInputs ??
          (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
        const builtInMic = audioInputs.find((d) => isBuiltInMicrophone(d.label));

        if (builtInMic) {
          logger.debug(
            "Using built-in microphone",
            { deviceId: builtInMic.deviceId, label: builtInMic.label },
            "audio"
          );
          return { audio: { deviceId: { exact: builtInMic.deviceId }, autoGainControl: true } };
        }
      } catch (error) {
        logger.debug(
          "Failed to enumerate devices for built-in mic detection",
          { error: error.message },
          "audio"
        );
      }
    }

    // Use selected device if specified and not preferring built-in
    if (!preferBuiltIn && selectedDeviceId) {
      logger.debug("Using selected microphone", { deviceId: selectedDeviceId }, "audio");
      return { audio: { deviceId: { exact: selectedDeviceId }, autoGainControl: true } };
    }

    // Fall back to default device
    logger.debug("Using default microphone", {}, "audio");
    return { audio: { autoGainControl: true } };
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
          if (audioBlob?.size > 0) {
            const recoveryId = await this.stageDictationRecovery(audioBlob, { durationSeconds });
            await this.markDictationRecoveryCanceled(recoveryId);
          }
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

        await this.processAudio(audioBlob, { durationSeconds });
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
      const recoveryId = this.recoveryIdsByGeneration.get(this.processingGeneration);
      void this.markDictationRecoveryCanceled(recoveryId);
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
    const recoveryId = await this.stageDictationRecovery(audioBlob, metadata);
    if (recoveryId) {
      this.recoveryIdsByGeneration.set(processingGeneration, recoveryId);
    }

    try {
      const { result, useLocalWhisper, localProvider, activeModel } = await this.runTranscription(
        audioBlob,
        processingMetadata
      );

      if (!this.isCurrentProcessingGeneration(processingGeneration)) {
        await this.markDictationRecoveryCanceled(recoveryId);
        return;
      }

      // Add actual recording duration to result for stats tracking
      if (metadata.durationSeconds) {
        result.durationSeconds = metadata.durationSeconds;
      }
      result.processingGeneration = processingGeneration;
      result.completeness = assessTranscriptionCompleteness({
        text: result.text,
        durationSeconds: result.durationSeconds ?? metadata.durationSeconds,
      });

      const completionResult = await this.onTranscriptionComplete?.(result, {
        processingGeneration,
        isCurrent: () => this.isCurrentProcessingGeneration(processingGeneration),
      });

      if (!this.isCurrentProcessingGeneration(processingGeneration)) {
        await this.markDictationRecoveryCanceled(recoveryId);
        return;
      }

      if (result.completeness.suspicious || completionResult?.recoverable === false) {
        await this.markDictationRecoveryFailed(
          recoveryId,
          result.completeness.suspicious
            ? "Transcription may be incomplete for the recorded duration"
            : completionResult?.reason || "History, paste, and clipboard delivery failed"
        );
      } else {
        await this.completeDictationRecovery(recoveryId);
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
        await this.markDictationRecoveryCanceled(recoveryId);
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
      await this.markDictationRecoveryFailed(recoveryId, error?.message || "Transcription failed");

      logger.error(
        "Pipeline failed",
        {
          errorAtMs,
          error: error.message,
        },
        "performance"
      );

      if (error.message !== "No audio detected") {
        this.onError?.({
          title: "Transcription Error",
          description: `Transcription failed: ${error.message}`,
        });
      }
    } finally {
      this.recoveryIdsByGeneration.delete(processingGeneration);
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
        for (const recoveryId of this.longSession.recoveryIds || []) {
          await this.markDictationRecoveryCanceled(recoveryId);
        }
        return;
      }

      result.processingGeneration = processingGeneration;
      result.completeness = assessTranscriptionCompleteness({
        text: result.text,
        durationSeconds,
      });

      const completionResult = await this.onTranscriptionComplete?.(result, {
        processingGeneration,
        isCurrent: () => this.isCurrentProcessingGeneration(processingGeneration),
      });

      if (!this.isCurrentProcessingGeneration(processingGeneration)) {
        for (const recoveryId of this.longSession.recoveryIds || []) {
          await this.markDictationRecoveryCanceled(recoveryId);
        }
        return;
      }

      for (const recoveryId of this.longSession.recoveryIds || []) {
        if (this.longSession.failedRecoveryIds?.has(recoveryId)) {
          continue;
        }
        if (result.completeness.suspicious || completionResult?.recoverable === false) {
          await this.markDictationRecoveryFailed(
            recoveryId,
            result.completeness.suspicious
              ? "Transcription may be incomplete for the recorded duration"
              : completionResult?.reason || "History, paste, and clipboard delivery failed"
          );
        } else {
          await this.completeDictationRecovery(recoveryId);
        }
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
        for (const recoveryId of this.longSession.recoveryIds || []) {
          await this.markDictationRecoveryCanceled(recoveryId);
        }
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

      for (const recoveryId of this.longSession.recoveryIds || []) {
        await this.markDictationRecoveryFailed(
          recoveryId,
          error?.message || "Long-session transcription failed"
        );
      }

      if (error.message !== "No audio detected") {
        this.onError?.({
          title: "Transcription Error",
          description: `Transcription failed: ${error.message}`,
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
    const localProvider = this.getTranscriptionSetting("localTranscriptionProvider", "whisper");
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

    return { result, useLocalWhisper, localProvider, activeModel };
  }

  async processWithLocalWhisper(audioBlob, model = "base", metadata = {}) {
    const timings = {};

    try {
      // Correction Memory is an approved-tester beta. Never read or inject its
      // hints for Starter or ordinary paid Pro users.
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
      }
      if (resolvedLanguage) {
        options.language = resolvedLanguage;
      }
      const shouldTranslate = shouldTranslateLocalWhisperToEnglish({
        translateToEnglish,
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

      logger.debug(
        "Local transcription complete",
        {
          transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
          success: result.success,
        },
        "performance"
      );

      if (result.success && result.text) {
        if (metadata?.skipPostProcessing) {
          return { success: true, text: result.text, source: "local", timings };
        }

        const reasoningStart = performance.now();
        const text = await this.processTranscription(result.text, "local");
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        if (text !== null && text !== undefined) {
          return { success: true, text: text || result.text, source: "local", timings };
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
      const result = await window.electronAPI.transcribeLocalParakeet(arrayBuffer, options);
      timings.transcriptionProcessingDurationMs = Math.round(
        performance.now() - transcriptionStart
      );

      logger.debug(
        "Parakeet transcription complete",
        {
          transcriptionProcessingDurationMs: timings.transcriptionProcessingDurationMs,
          success: result.success,
        },
        "performance"
      );

      if (result.success && result.text) {
        if (metadata?.skipPostProcessing) {
          return { success: true, text: result.text, source: "local-parakeet", timings };
        }

        const reasoningStart = performance.now();
        const text = await this.processTranscription(result.text, "local-parakeet");
        timings.reasoningProcessingDurationMs = Math.round(performance.now() - reasoningStart);

        if (text !== null && text !== undefined) {
          return { success: true, text: text || result.text, source: "local-parakeet", timings };
        } else {
          throw new Error("No text transcribed");
        }
      } else if (result.success === false && result.message === "No audio detected") {
        throw new Error("No audio detected");
      } else {
        throw new Error(result.message || result.error || "Parakeet transcription failed");
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
            `Parakeet failed: ${error.message}. OpenAI fallback also failed: ${fallbackError.message}`
          );
        }
      } else {
        throw new Error(`Parakeet failed: ${error.message}`);
      }
    }
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
    const now = Date.now();
    const cacheValid =
      this.reasoningAvailabilityCache &&
      now < this.reasoningAvailabilityCache.expiresAt &&
      this.cachedReasoningPreference === storedValue;

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
      this.cachedReasoningPreference = storedValue;
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
      this.cachedReasoningPreference = storedValue;

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
      this.cachedReasoningPreference = storedValue;
      return false;
    }
  }

  /**
   * Apply custom dictionary word replacements to raw STT output.
   * Whisper's initialPrompt is a hint, not a guarantee - it can still mis-transcribe
   * or mis-capitalise custom words. This does a case-insensitive whole-word scan and
   * replaces any match with the exact casing stored in the dictionary.
   *
   * Example: dictionary has "PrivateTranscribe", Whisper outputs "provoca" → fixed to "PrivateTranscribe".
   *
   * Replacements are whole-word only (word boundaries) so "unprovocative" is untouched.
   */
  applyDictionaryReplacements(text) {
    try {
      const raw = localStorage.getItem("customDictionary");
      if (!raw) return text;
      const words = JSON.parse(raw);
      if (!Array.isArray(words) || words.length === 0) return text;
      const repairWords = getDictionaryRepairTerms(
        words,
        parseDictionaryEntryModes(localStorage.getItem("dictionaryEntryModes"))
      );
      if (repairWords.length === 0) return text;

      let result = repairSplitDictionaryTerms(text, repairWords);
      for (const word of repairWords) {
        if (!word || typeof word !== "string") continue;
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
      typeof window !== "undefined" && window.localStorage
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
          { dictationMode, preferredLanguage, smartContext: this._cachedSmartContext ?? null }
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
    const language = this.getTranscriptionSetting("preferredLanguage", "");
    const allowLocalFallback =
      this.getTranscriptionSetting("allowLocalFallback", "false") === "true";
    const fallbackModel = this.getTranscriptionSetting("fallbackWhisperModel", "base");
    const source = metadata?.source || "dictation";
    const originalFileName = metadata?.originalFileName || null;
    const skipOptimizationByMetadata = metadata?.skipOptimization === true;
    const processingGeneration = metadata?.processingGeneration ?? null;
    const abortController = new AbortController();

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
      if (processingGeneration !== null && processingGeneration !== undefined) {
        this.setActiveTranscriptionAbortController(abortController, processingGeneration);
      }
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
          const options = {
            model: fallbackModel,
          };
          if (language && language !== "auto") {
            options.language = language;
          }
          if (originalFileName) {
            options.inputFileName = originalFileName;
          }

          const result = await window.electronAPI.transcribeLocalWhisper(arrayBuffer, options);

          if (result.success && result.text) {
            if (metadata?.skipPostProcessing) {
              return { success: true, text: result.text, source: "local-fallback" };
            }

            const text = await this.processTranscription(result.text, "local-fallback");
            if (text) {
              return { success: true, text, source: "local-fallback" };
            }
          }
          throw error;
        } catch (fallbackError) {
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
    if (resolvedLanguage) options.language = resolvedLanguage;
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

  async safePaste(text) {
    try {
      const result = await window.electronAPI.pasteText(text);
      if (result?.delivered === false) {
        this.onError?.({
          title: "Paste not confirmed",
          description:
            "PrivateTranscribe could not confirm insertion. The transcription was copied to the clipboard for manual paste.",
        });
        return false;
      }
      return true;
    } catch (error) {
      this.onError?.({
        title: "Paste Error",
        description: `Failed to paste text. Please check accessibility permissions. ${error.message}`,
      });
      return false;
    }
  }

  async saveTranscription(text, durationSeconds = null) {
    try {
      const result = await window.electronAPI.saveTranscription(text, durationSeconds);
      return result?.success === true;
    } catch (error) {
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
    if (navigator.mediaDevices && this._deviceChangeHandler) {
      navigator.mediaDevices.removeEventListener("devicechange", this._deviceChangeHandler);
      this._deviceChangeHandler = null;
    }
    this._systemResumedCleanup?.();
    this._systemResumedCleanup = null;
  }
}

export default AudioManager;
