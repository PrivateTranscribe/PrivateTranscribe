const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");
const debugLogger = require("./debugLogger");
const { downloadFile, createDownloadSignal } = require("./downloadUtils");
const WhisperServerManager = require("./whisperServer");
const GpuBinaryManager = require("./gpuBinaryManager");
const { getModelsDirForService } = require("./modelDirUtils");
const { DiarizationManager } = require("./diarizationManager");
const { assignSpeakersToSegments } = require("./diarizationMerge");
const { normalizeTranscriptText } = require("../utils/textNormalization");

const modelRegistryData = require("../models/modelRegistryData.json");

const CACHE_TTL_MS = 30000;
const MIN_VALID_MODEL_BYTES = 1_000_000;
const MIN_EXPECTED_MODEL_RATIO = 0.9;

function getWhisperModelConfig(modelName) {
  const modelInfo = modelRegistryData.whisperModels[modelName];
  if (!modelInfo) return null;
  return {
    url: modelInfo.downloadUrl,
    size: modelInfo.sizeMb * 1_000_000,
    fileName: modelInfo.fileName,
  };
}

function getValidModelNames() {
  return Object.keys(modelRegistryData.whisperModels);
}

function getMinimumValidModelBytes(modelName) {
  const modelConfig = getWhisperModelConfig(modelName);
  return modelConfig?.size
    ? Math.floor(modelConfig.size * MIN_EXPECTED_MODEL_RATIO)
    : MIN_VALID_MODEL_BYTES;
}

function getInvalidModelMessage(modelName, actualBytes) {
  const minBytes = getMinimumValidModelBytes(modelName);
  return `Whisper model "${modelName}" is incomplete or corrupt (${Math.round(
    actualBytes / (1024 * 1024)
  )}MB, expected at least ${Math.round(minBytes / (1024 * 1024))}MB). Please re-download it from Settings.`;
}

function isPathInsideDirectory(childPath, parentDir) {
  const relative = path.relative(path.resolve(parentDir), path.resolve(childPath));
  return (
    relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

class WhisperManager {
  constructor() {
    this.cachedFFmpegPath = null;
    this.currentDownloadProcess = null;
    this.activeDownloadModel = null;
    this.ffmpegAvailabilityCache = { result: null, expiresAt: 0 };
    this.isInitialized = false;
    // Server manager for HTTP-based transcription
    this.serverManager = new WhisperServerManager();
    this.currentServerModel = null;
    // GPU binary manager for on-demand CUDA binary downloads
    this.gpuBinaryManager = new GpuBinaryManager();
    this.diarizationManager = new DiarizationManager();
  }

  getModelsDir() {
    return getModelsDirForService("whisper");
  }

  validateModelName(modelName) {
    // Only allow known model names to prevent path traversal attacks
    const validModels = getValidModelNames();
    if (!validModels.includes(modelName)) {
      throw new Error(`Invalid model name: ${modelName}. Valid models: ${validModels.join(", ")}`);
    }
    return true;
  }

  getModelPath(modelName) {
    this.validateModelName(modelName);
    const config = getWhisperModelConfig(modelName);
    const modelsDir = this.getModelsDir();
    const modelPath = path.resolve(modelsDir, config.fileName);

    if (!isPathInsideDirectory(modelPath, modelsDir)) {
      throw new Error(`Invalid model path for ${modelName}`);
    }

    return modelPath;
  }

  async initializeAtStartup(settings = {}) {
    const startTime = Date.now();

    try {
      this.isInitialized = true;

      if (
        typeof settings.whisperServerIdleTimeoutMinutes === "number" &&
        Number.isFinite(settings.whisperServerIdleTimeoutMinutes)
      ) {
        // 0 => disable auto-stop
        const minutes = Math.max(0, settings.whisperServerIdleTimeoutMinutes);
        this.serverManager.setIdleTimeoutMs(minutes * 60 * 1000);
      }

      if (typeof settings.whisperForceCpu === "boolean") {
        await this.serverManager.setForceCpu(settings.whisperForceCpu);
      }
    } catch (error) {
      debugLogger.warn("Whisper initialization error", {
        error: error.message,
      });
      this.isInitialized = true; // Mark initialized even on error
    }

    debugLogger.info("Whisper initialization complete", {
      totalTimeMs: Date.now() - startTime,
      serverRunning: this.serverManager.ready,
    });

    // Log dependency status for debugging
    await this.logDependencyStatus();
  }

  async logDependencyStatus() {
    const status = {
      whisperServer: {
        available: this.serverManager.isAvailable(),
        path: this.serverManager.getServerBinaryPath(),
      },
      ffmpeg: {
        available: false,
        path: null,
      },
      models: [],
    };

    // Check FFmpeg
    try {
      const ffmpegPath = await this.getFFmpegPath();
      status.ffmpeg.available = !!ffmpegPath;
      status.ffmpeg.path = ffmpegPath;
    } catch {
      // FFmpeg not available
    }

    // Check downloaded models
    for (const modelName of getValidModelNames()) {
      const modelPath = this.getModelPath(modelName);
      if (fs.existsSync(modelPath)) {
        try {
          const stats = fs.statSync(modelPath);
          status.models.push({
            name: modelName,
            size: `${Math.round(stats.size / (1024 * 1024))}MB`,
          });
        } catch {
          // Skip if can't stat
        }
      }
    }

    debugLogger.info("PrivateTranscribe dependency check", status);

    // Log a summary for easy scanning
    const serverStatus = status.whisperServer.available
      ? `✓ ${status.whisperServer.path}`
      : "✗ Not found";
    const ffmpegStatus = status.ffmpeg.available ? `✓ ${status.ffmpeg.path}` : "✗ Not found";
    const modelsStatus =
      status.models.length > 0
        ? status.models.map((m) => `${m.name} (${m.size})`).join(", ")
        : "None downloaded";

    debugLogger.info(`[Dependencies] whisper-server: ${serverStatus}`);
    debugLogger.info(`[Dependencies] FFmpeg: ${ffmpegStatus}`);
    debugLogger.info(`[Dependencies] Models: ${modelsStatus}`);
  }

  async startServer(modelName) {
    if (!this.serverManager.isAvailable()) {
      return { success: false, reason: "whisper-server binary not found" };
    }

    const modelPath = this.getModelPath(modelName);
    if (!fs.existsSync(modelPath)) {
      return { success: false, reason: `Model "${modelName}" not downloaded` };
    }

    try {
      await this.serverManager.start(modelPath, { printRealtime: false });
      this.currentServerModel = modelName;
      debugLogger.info("whisper-server started", {
        model: modelName,
        port: this.serverManager.port,
      });
      return { success: true, port: this.serverManager.port };
    } catch (error) {
      debugLogger.error("Failed to start whisper-server", { error: error.message });
      return { success: false, reason: error.message };
    }
  }

  async stopServer() {
    await this.serverManager.stop();
    this.currentServerModel = null;
  }

  setServerIdleTimeoutMinutes(minutes) {
    const parsed = Number(minutes);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error("Invalid idle timeout minutes");
    }
    return this.serverManager.setIdleTimeoutMs(parsed * 60 * 1000);
  }

  getServerStatus() {
    return this.serverManager.getStatus();
  }

  getEngineStatus() {
    return this.serverManager.getEngineStatus();
  }

  setEngineFallbackListener(listener) {
    this.serverManager.onEngineFallbackChanged = listener;
  }

  hasCudaBinary() {
    return this.gpuBinaryManager.hasCudaBinary();
  }

  wasCudaPreviouslyInstalled() {
    return this.gpuBinaryManager.wasCudaPreviouslyInstalled();
  }

  async migrateLegacyCudaBinary() {
    return this.gpuBinaryManager.migrateLegacyCudaBinary();
  }

  isCudaBinaryUpToDate() {
    return this.gpuBinaryManager.isCudaBinaryUpToDate();
  }

  async getLatestAvailableCudaVersion() {
    return this.gpuBinaryManager.fetchLatestAvailableVersion();
  }

  async downloadGpuBinary(onProgress) {
    return this.gpuBinaryManager.downloadCudaBinary(onProgress);
  }

  async invalidateServerCache(options = {}) {
    await this.serverManager.invalidateServerCache(options);
    this.currentServerModel = null;
  }

  cancelGpuBinaryDownload() {
    this.gpuBinaryManager.cancelDownload();
  }

  async setForceCpu(value) {
    await this.serverManager.setForceCpu(value);
  }

  isProcessing() {
    return this.serverManager.isProcessing();
  }

  getCudaBinaryStatus() {
    const key = this.gpuBinaryManager.getPlatformKey();
    const installedPath = this.gpuBinaryManager.getCudaBinaryFilePath();
    const version = this.gpuBinaryManager.getCudaBinaryVersion();
    const upToDate = this.gpuBinaryManager.isCudaBinaryUpToDate();
    // "installed" should mean a CUDA engine exists, even if it is outdated.
    // Readiness is represented by installed && upToDate. The UI needs this
    // distinction to show "Update CUDA Engine" instead of hiding update state.
    const installed = !!installedPath;
    const expectedVersion = this.gpuBinaryManager.getExpectedCudaBinaryVersion();
    return {
      installed,
      path: installedPath,
      platform: key,
      supported: !!GpuBinaryManager.CUDA_BINARIES[key],
      version,
      upToDate,
      expectedVersion,
      forceCpu: this.serverManager.forceCpu,
      engineStatus: this.serverManager.getEngineStatus?.() || null,
    };
  }

  async checkWhisperInstallation() {
    const serverPath = this.serverManager.getServerBinaryPath();
    if (!serverPath) {
      return { installed: false, working: false };
    }

    return {
      installed: true,
      working: this.serverManager.isAvailable(),
      path: serverPath,
    };
  }

  async transcribeLocalWhisper(audioBlob, options = {}) {
    debugLogger.logWhisperPipeline("transcribeLocalWhisper - start", {
      options,
      audioBlobType: audioBlob?.constructor?.name,
      audioBlobSize: audioBlob?.byteLength || audioBlob?.size || 0,
      serverAvailable: this.serverManager.isAvailable(),
      serverReady: this.serverManager.ready,
      forceCpu: this.serverManager.forceCpu,
      activeServerBinaryPath: this.serverManager.activeServerBinaryPath,
    });

    // Engine mode is managed exclusively via setDesiredMode/setForceCpu IPC.
    // Per-request mutation was removed to prevent server restart churn.
    // Benchmark manager calls setForceCpu() directly for comparison legs.

    // Server mode required
    if (!this.serverManager.isAvailable()) {
      throw new Error(
        "whisper-server binary not found. Please ensure the app is installed correctly."
      );
    }

    const model = options.model || "turbo";
    const language = options.language || null;
    const translate = options.translate || false;
    const initialPrompt = options.initialPrompt || null;
    const inputFileName = options.inputFileName || null;
    const modelPath = this.getModelPath(model);

    // Check if model exists and looks complete
    const modelStatus = this.getModelFileStatus(model);
    if (!modelStatus.exists) {
      throw new Error(`Whisper model "${model}" not downloaded. Please download it from Settings.`);
    }
    if (!modelStatus.valid) {
      throw new Error(getInvalidModelMessage(model, modelStatus.size));
    }

    return await this.transcribeViaServer(
      audioBlob,
      model,
      language,
      initialPrompt,
      inputFileName,
      translate,
      {
        fileMode: options.fileMode === true,
        noiseReduction: options.noiseReduction === true,
        speakerDetection: options.speakerDetection === true,
        outputFormat: options.outputFormat || "plain",
        diarize: options.diarize === true,
        vad: options.vad === true,
        longSessionChunk: options.longSessionChunk === true,
        trimTrailingSilence: options.trimTrailingSilence === true,
        onProgress: options.onProgress,
      }
    );
  }

  async transcribeViaServer(
    audioBlob,
    model,
    language,
    initialPrompt = null,
    inputFileName = null,
    translate = false,
    requestOptions = {}
  ) {
    debugLogger.info("Transcription mode: SERVER", {
      model,
      language: language || "auto",
      currentServerModel: this.currentServerModel,
      loadedServerModelPath: this.serverManager.loadedModelPath || null,
      serverPid: this.serverManager.process?.pid || null,
    });
    const modelPath = this.getModelPath(model);

    // Start server if not running, was auto-stopped due to idleness, or if model changed
    if (
      !this.serverManager.ready ||
      this.serverManager.stoppedDueToIdle ||
      this.currentServerModel !== model
    ) {
      debugLogger.debug("Starting/restarting whisper-server for model", {
        model,
        modelPath,
        previousModel: this.currentServerModel,
        previousLoadedModelPath: this.serverManager.loadedModelPath || null,
        previousPid: this.serverManager.process?.pid || null,
        reason: !this.serverManager.ready
          ? "not running"
          : this.serverManager.stoppedDueToIdle
            ? "stopped due to idle"
            : "model changed",
      });
      await this.serverManager.start(modelPath, {
        printRealtime: requestOptions.fileMode === true && requestOptions.speakerDetection === true,
      });
      this.currentServerModel = model;
    }

    // Convert audioBlob to Buffer if needed
    let audioBuffer;
    if (Buffer.isBuffer(audioBlob)) {
      audioBuffer = audioBlob;
    } else if (ArrayBuffer.isView(audioBlob)) {
      audioBuffer = Buffer.from(audioBlob.buffer, audioBlob.byteOffset, audioBlob.byteLength);
    } else if (audioBlob instanceof ArrayBuffer) {
      audioBuffer = Buffer.from(audioBlob);
    } else if (typeof audioBlob === "string") {
      audioBuffer = Buffer.from(audioBlob, "base64");
    } else if (audioBlob && audioBlob.buffer && typeof audioBlob.byteLength === "number") {
      audioBuffer = Buffer.from(audioBlob.buffer, audioBlob.byteOffset || 0, audioBlob.byteLength);
    } else {
      throw new Error(`Unsupported audio data type: ${typeof audioBlob}`);
    }

    if (!audioBuffer || audioBuffer.length === 0) {
      throw new Error("Audio buffer is empty - no audio data received");
    }

    debugLogger.logWhisperPipeline("transcribeViaServer - sending to server", {
      bufferSize: audioBuffer.length,
      model,
      language,
      port: this.serverManager.port,
    });

    const startTime = Date.now();
    const result = await this.serverManager.transcribe(audioBuffer, {
      language,
      translate,
      initialPrompt,
      inputFileName,
      ...requestOptions,
    });
    const elapsed = Date.now() - startTime;

    debugLogger.logWhisperPipeline("transcribeViaServer - completed", {
      elapsed,
      resultKeys: Object.keys(result),
    });

    const parsed = this.parseWhisperResult(result);
    if (requestOptions.fileMode && parsed.success) {
      return { ...parsed, raw: result, segments: result?.segments || [] };
    }
    return parsed;
  }

  async audioBlobToBuffer(audioBlob) {
    if (Buffer.isBuffer(audioBlob)) {
      return audioBlob;
    }
    if (ArrayBuffer.isView(audioBlob)) {
      return Buffer.from(audioBlob.buffer, audioBlob.byteOffset, audioBlob.byteLength);
    }
    if (audioBlob instanceof ArrayBuffer) {
      return Buffer.from(audioBlob);
    }
    if (typeof audioBlob === "string") {
      // Async read — file-mode inputs can be large audio recordings.
      return fs.promises.readFile(audioBlob);
    }
    throw new Error(`Unsupported audio data type for diarization: ${typeof audioBlob}`);
  }

  getModelFileStatus(modelName) {
    const modelPath = this.getModelPath(modelName);

    if (!fs.existsSync(modelPath)) {
      return { modelPath, exists: false, valid: false, size: 0 };
    }

    const stats = fs.statSync(modelPath);
    const minSize = getMinimumValidModelBytes(modelName);
    return {
      modelPath,
      exists: true,
      valid: stats.size >= minSize,
      size: stats.size,
      minSize,
    };
  }

  isModelDownloaded(modelName) {
    try {
      return this.getModelFileStatus(modelName).valid;
    } catch {
      return false;
    }
  }

  getDiarizationModelStatus() {
    return this.diarizationManager.getModelStatus();
  }

  async downloadDiarizationModels(onProgress) {
    return await this.diarizationManager.downloadModels(onProgress);
  }

  async transcribeFileV2(audioBlob, options = {}) {
    const speakerDetectionMode =
      options.speakerDetectionMode ||
      (options.speakerDetection === true ? "tiny-diarize-en" : "off");
    const requestedTinyDiarize = speakerDetectionMode === "tiny-diarize-en";
    const requestedLocalDiarization = speakerDetectionMode === "local-diarization";
    const model =
      requestedTinyDiarize && this.isModelDownloaded("small-en-tdrz")
        ? "small-en-tdrz"
        : options.model || "turbo";
    const onProgress = options.onProgress;
    const result = await this.transcribeLocalWhisper(audioBlob, {
      ...options,
      model,
      fileMode: true,
      speakerDetection: requestedTinyDiarize && model === "small-en-tdrz",
      // VAD requires a separate Silero VAD model with whisper-server. Keep it opt-in
      // so normal file transcription does not fail on installations without that model.
      vad: options.vad === true,
      onProgress,
    });

    if (requestedLocalDiarization && result?.success && Array.isArray(result.segments)) {
      if (typeof onProgress === "function") {
        onProgress({ stage: "diarizing", percentage: 0 });
      }
      const inputBuffer = await this.audioBlobToBuffer(audioBlob);
      const wavBuffer = await this.serverManager.convertToDiarizationWav(
        inputBuffer,
        options.inputFileName,
        {
          noiseReduction: options.noiseReduction === true,
        }
      );
      const diarization = await this.diarizationManager.diarizeWavBufferInWorker(wavBuffer, {
        expectedSpeakers: options.expectedSpeakers,
        threshold: options.diarizationThreshold,
      });
      if (typeof onProgress === "function") {
        onProgress({ stage: "diarizing", percentage: 100 });
      }
      const segments = assignSpeakersToSegments(result.segments, diarization.segments);
      return {
        ...result,
        raw: { ...(result.raw || {}), segments },
        segments,
        model,
        speakerDetectionActive: true,
        speakerDetectionMode: "local-diarization",
        diarizationEngine: diarization.engine,
        diarization,
        speakerCount: diarization.speakerCount,
      };
    }

    return {
      ...result,
      model,
      speakerDetectionActive: requestedTinyDiarize && model === "small-en-tdrz",
      speakerDetectionMode:
        requestedTinyDiarize && model === "small-en-tdrz" ? "tiny-diarize-en" : "off",
    };
  }

  // Normalize whitespace: replace newlines with spaces and collapse multiple spaces
  // whisper.cpp returns text with \n between audio segments which causes formatting issues
  normalizeWhitespace(text) {
    return normalizeTranscriptText(text);
  }

  // Detect and remove repetitive phrases that whisper.cpp sometimes hallucinates.
  // Works by finding any phrase (3+ words) repeated 3+ times consecutively and
  // collapsing it to a single occurrence.  Also catches single-word stutters
  // repeated 5+ times (e.g. "the the the the the").
  removeRepetitions(text) {
    if (!text) return text;

    let cleaned = text;

    // A long run of the same punctuated word at the very end is a common
    // Whisper-on-silence artifact (for example, "Yeah. Yeah. Yeah..."). Drop
    // the whole tail rather than preserving one invented word.
    cleaned = cleaned
      .replace(/(?:^|\s)([\p{L}\p{N}'’]+)(?:[.!?,;:…]+)?(?:\s+\1(?:[.!?,;:…]+)?){4,}\s*$/iu, "")
      .trim();

    // 1) Collapse long repeated phrases (3–30 word n-grams repeated 3+ times)
    //    Uses a greedy approach: try longest n-gram first so we catch the biggest loops.
    // Whisper can also emit a whole sentence or passage twice around long-form
    // decode boundaries. Collapse exact adjacent duplicates only when the phrase
    // is long enough that an intentional repeat is unlikely.
    for (let n = 50; n >= 8; n--) {
      const duplicatePassagePattern = new RegExp(`((?:\\S+\\s+){${n - 1}}\\S+)(?:\\s+\\1)+`, "gi");
      cleaned = cleaned.replace(duplicatePassagePattern, "$1");
    }

    for (let n = 30; n >= 3; n--) {
      // Build a regex that matches an n-word phrase repeated 3+ times in a row.
      // The phrase is captured, then required to repeat (with whitespace) 2+ more times.
      const phrasePattern = new RegExp(`((?:\\S+\\s+){${n - 1}}\\S+)(?:\\s+\\1){2,}`, "gi");
      cleaned = cleaned.replace(phrasePattern, "$1");
    }

    // 2) Collapse single-word stutters (5+ consecutive identical words)
    cleaned = cleaned.replace(/\b(\w+)(?:\s+\1){4,}\b/gi, "$1");

    // 3) Re-normalize whitespace after replacements
    cleaned = normalizeTranscriptText(cleaned);

    if (cleaned !== text) {
      debugLogger.info("Removed whisper repetition artifacts", {
        originalLength: text.length,
        cleanedLength: cleaned.length,
      });
    }

    return cleaned;
  }

  parseWhisperResult(output) {
    // Handle both string (from CLI) and object (from server) inputs
    let result;
    if (typeof output === "string") {
      debugLogger.logWhisperPipeline("Parsing result (string)", { length: output.length });
      try {
        result = JSON.parse(output);
      } catch (parseError) {
        // Try parsing as plain text (non-JSON output)
        const text = this.normalizeWhitespace(output);
        if (text && !this.isBlankAudioMarker(text)) {
          return { success: true, text };
        }
        if (this.isBlankAudioMarker(output)) {
          return { success: false, message: "No audio detected" };
        }
        throw new Error(`Failed to parse Whisper output: ${parseError.message}`);
      }
    } else if (typeof output === "object" && output !== null) {
      debugLogger.logWhisperPipeline("Parsing result (object)", { keys: Object.keys(output) });
      result = output;
    } else {
      throw new Error(`Unexpected Whisper output type: ${typeof output}`);
    }

    // Handle whisper.cpp JSON format (CLI mode)
    if (result.transcription && Array.isArray(result.transcription)) {
      const text = this.removeRepetitions(
        this.normalizeWhitespace(result.transcription.map((seg) => seg.text).join(""))
      );
      if (!text || this.isBlankAudioMarker(text)) {
        return { success: false, message: "No audio detected" };
      }
      return { success: true, text };
    }

    // Handle whisper-server format (has "text" field directly)
    if (result.text !== undefined) {
      const text = this.removeRepetitions(
        typeof result.text === "string" ? this.normalizeWhitespace(result.text) : ""
      );
      if (!text || this.isBlankAudioMarker(text)) {
        return { success: false, message: "No audio detected" };
      }
      return { success: true, text };
    }

    return { success: false, message: "No audio detected" };
  }

  // Check if text is a whisper.cpp blank audio marker
  isBlankAudioMarker(text) {
    // whisper.cpp outputs "[BLANK_AUDIO]" when there's silence or insufficient audio
    const normalized = text.trim().toLowerCase();
    return normalized === "[blank_audio]" || normalized === "[ blank_audio ]";
  }

  async downloadWhisperModel(modelName, progressCallback = null) {
    this.validateModelName(modelName);
    const modelConfig = getWhisperModelConfig(modelName);

    const modelPath = this.getModelPath(modelName);
    const modelsDir = this.getModelsDir();

    await fsPromises.mkdir(modelsDir, { recursive: true });

    if (fs.existsSync(modelPath)) {
      const stats = await fsPromises.stat(modelPath);
      if (stats.size >= getMinimumValidModelBytes(modelName)) {
        return {
          model: modelName,
          downloaded: true,
          path: modelPath,
          size_bytes: stats.size,
          size_mb: Math.round(stats.size / (1024 * 1024)),
          success: true,
        };
      }

      debugLogger.warn("Removing incomplete Whisper model before re-download", {
        model: modelName,
        path: modelPath,
        sizeBytes: stats.size,
      });
      await fsPromises.unlink(modelPath).catch(() => {});
    }

    if (this.currentDownloadProcess) {
      return {
        model: modelName,
        downloaded: false,
        success: false,
        error: `Whisper model download already in progress: ${this.activeDownloadModel || "unknown"}`,
      };
    }

    const { signal, abort } = createDownloadSignal();
    const downloadProcess = { abort };
    this.currentDownloadProcess = downloadProcess;
    this.activeDownloadModel = modelName;

    try {
      await downloadFile(modelConfig.url, modelPath, {
        timeout: 600000,
        signal,
        onProgress: (downloadedBytes, totalBytes) => {
          if (progressCallback) {
            progressCallback({
              type: "progress",
              model: modelName,
              downloaded_bytes: downloadedBytes,
              total_bytes: totalBytes,
              percentage: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
            });
          }
        },
      });

      const stats = await fsPromises.stat(modelPath);
      const minSize = getMinimumValidModelBytes(modelName);

      // TODO: Verify downloaded Whisper models against a SHA256 manifest.
      if (stats.size < minSize) {
        await fsPromises.unlink(modelPath).catch(() => {});
        throw new Error(getInvalidModelMessage(modelName, stats.size));
      }

      if (progressCallback) {
        progressCallback({ type: "complete", model: modelName, percentage: 100 });
      }

      return {
        model: modelName,
        downloaded: true,
        path: modelPath,
        size_bytes: stats.size,
        size_mb: Math.round(stats.size / (1024 * 1024)),
        success: true,
      };
    } catch (error) {
      if (error.isAbort) {
        throw new Error("Download interrupted by user");
      }
      throw error;
    } finally {
      if (this.currentDownloadProcess === downloadProcess) {
        this.currentDownloadProcess = null;
        this.activeDownloadModel = null;
      }
    }
  }

  async cancelDownload() {
    if (this.currentDownloadProcess) {
      this.currentDownloadProcess.abort();
      this.currentDownloadProcess = null;
      this.activeDownloadModel = null;
      return { success: true, message: "Download cancelled" };
    }
    return { success: false, error: "No active download to cancel" };
  }

  async checkModelStatus(modelName) {
    const modelPath = this.getModelPath(modelName);

    if (fs.existsSync(modelPath)) {
      const stats = await fsPromises.stat(modelPath);
      const downloaded = stats.size >= getMinimumValidModelBytes(modelName);
      return {
        model: modelName,
        downloaded,
        valid: downloaded,
        path: modelPath,
        size_bytes: stats.size,
        size_mb: Math.round(stats.size / (1024 * 1024)),
        error: downloaded ? undefined : getInvalidModelMessage(modelName, stats.size),
        success: true,
      };
    }

    return { model: modelName, downloaded: false, success: true };
  }

  async listWhisperModels() {
    const models = getValidModelNames();
    const modelInfo = [];

    for (const model of models) {
      const status = await this.checkModelStatus(model);
      modelInfo.push(status);
    }

    return {
      models: modelInfo,
      cache_dir: this.getModelsDir(),
      success: true,
    };
  }

  async deleteWhisperModel(modelName) {
    const modelPath = this.getModelPath(modelName);

    if (fs.existsSync(modelPath)) {
      const stats = await fsPromises.stat(modelPath);
      await fsPromises.unlink(modelPath);
      return {
        model: modelName,
        deleted: true,
        freed_bytes: stats.size,
        freed_mb: Math.round(stats.size / (1024 * 1024)),
        success: true,
      };
    }

    return { model: modelName, deleted: false, error: "Model not found", success: false };
  }

  async deleteAllWhisperModels() {
    const modelsDir = this.getModelsDir();
    let totalFreed = 0;
    let deletedCount = 0;

    try {
      if (!fs.existsSync(modelsDir)) {
        return { success: true, deleted_count: 0, freed_bytes: 0, freed_mb: 0 };
      }

      const files = await fsPromises.readdir(modelsDir);
      for (const file of files) {
        if (file.endsWith(".bin")) {
          const filePath = path.join(modelsDir, file);
          try {
            const stats = await fsPromises.stat(filePath);
            await fsPromises.unlink(filePath);
            totalFreed += stats.size;
            deletedCount++;
          } catch {
            // Continue with other files if one fails
          }
        }
      }

      return {
        success: true,
        deleted_count: deletedCount,
        freed_bytes: totalFreed,
        freed_mb: Math.round(totalFreed / (1024 * 1024)),
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // FFmpeg methods (still needed for audio format conversion)
  async getFFmpegPath() {
    if (this.cachedFFmpegPath) {
      return this.cachedFFmpegPath;
    }

    let ffmpegPath;

    try {
      ffmpegPath = require("ffmpeg-static");
      ffmpegPath = path.normalize(ffmpegPath);

      if (process.platform === "win32" && !ffmpegPath.endsWith(".exe")) {
        ffmpegPath += ".exe";
      }

      debugLogger.debug("FFmpeg static path from module", { ffmpegPath });

      // Try unpacked ASAR path first (production builds unpack ffmpeg-static)
      // Handle both forward slashes and backslashes for cross-platform compatibility
      const unpackedPath = ffmpegPath.includes("app.asar")
        ? ffmpegPath.replace(/app\.asar([/\\])/, "app.asar.unpacked$1")
        : null;

      if (unpackedPath) {
        debugLogger.debug("Checking unpacked ASAR path", { unpackedPath });
        if (fs.existsSync(unpackedPath)) {
          if (process.platform !== "win32") {
            try {
              fs.accessSync(unpackedPath, fs.constants.X_OK);
            } catch {
              debugLogger.debug("FFmpeg not executable, attempting chmod", { unpackedPath });
              try {
                fs.chmodSync(unpackedPath, 0o755);
              } catch (chmodErr) {
                debugLogger.warn("Failed to chmod FFmpeg", { error: chmodErr.message });
              }
            }
          }
          debugLogger.debug("Found FFmpeg in unpacked ASAR", { path: unpackedPath });
          this.cachedFFmpegPath = unpackedPath;
          return unpackedPath;
        } else {
          debugLogger.warn("Unpacked ASAR path does not exist", { unpackedPath });
        }
      }

      // Try original path (development or if not in ASAR)
      if (fs.existsSync(ffmpegPath)) {
        if (process.platform !== "win32") {
          fs.accessSync(ffmpegPath, fs.constants.X_OK);
        }
        debugLogger.debug("Found FFmpeg at bundled path", { path: ffmpegPath });
        this.cachedFFmpegPath = ffmpegPath;
        return ffmpegPath;
      } else {
        debugLogger.warn("Bundled FFmpeg path does not exist", { ffmpegPath });
      }
    } catch (err) {
      debugLogger.warn("Bundled FFmpeg not available", { error: err.message });
    }

    // Try system FFmpeg paths
    const systemCandidates =
      process.platform === "darwin"
        ? ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]
        : process.platform === "win32"
          ? ["C:\\ffmpeg\\bin\\ffmpeg.exe"]
          : ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"];

    debugLogger.debug("Trying system FFmpeg candidates", { candidates: systemCandidates });

    for (const candidate of systemCandidates) {
      if (fs.existsSync(candidate)) {
        debugLogger.debug("Found system FFmpeg", { path: candidate });
        this.cachedFFmpegPath = candidate;
        return candidate;
      }
    }

    debugLogger.error("FFmpeg not found anywhere");
    return null;
  }

  async checkFFmpegAvailability() {
    const now = Date.now();
    if (
      this.ffmpegAvailabilityCache.result !== null &&
      now < this.ffmpegAvailabilityCache.expiresAt
    ) {
      return this.ffmpegAvailabilityCache.result;
    }

    const ffmpegPath = await this.getFFmpegPath();
    const result = ffmpegPath
      ? { available: true, path: ffmpegPath }
      : { available: false, error: "FFmpeg not found" };

    this.ffmpegAvailabilityCache = { result, expiresAt: now + CACHE_TTL_MS };
    return result;
  }

  async getDiagnostics() {
    const diagnostics = {
      platform: process.platform,
      arch: process.arch,
      resourcesPath: process.resourcesPath || null,
      isPackaged: !!process.resourcesPath && !process.resourcesPath.includes("node_modules"),
      ffmpeg: { available: false, path: null, error: null },
      whisperServer: { available: false, path: null },
      modelsDir: this.getModelsDir(),
      models: [],
    };

    // Check FFmpeg
    try {
      this.cachedFFmpegPath = null; // Clear cache for fresh check
      const ffmpegPath = await this.getFFmpegPath();
      if (ffmpegPath) {
        diagnostics.ffmpeg = { available: true, path: ffmpegPath, error: null };
      } else {
        diagnostics.ffmpeg = { available: false, path: null, error: "Not found" };
      }
    } catch (err) {
      diagnostics.ffmpeg = { available: false, path: null, error: err.message };
    }

    // Check whisper server
    if (this.serverManager) {
      const serverPath = this.serverManager.getServerBinaryPath?.();
      diagnostics.whisperServer = {
        available: this.serverManager.isAvailable(),
        path: serverPath || null,
      };
    }

    // Check downloaded models
    try {
      const modelsDir = this.getModelsDir();
      if (fs.existsSync(modelsDir)) {
        const files = fs.readdirSync(modelsDir);
        diagnostics.models = files
          .filter((f) => f.startsWith("ggml-") && f.endsWith(".bin"))
          .map((f) => f.replace("ggml-", "").replace(".bin", ""));
      }
    } catch {
      // Ignore errors reading models dir
    }

    return diagnostics;
  }
}

module.exports = WhisperManager;
