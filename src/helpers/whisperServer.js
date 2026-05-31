const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");
const http = require("http");
const FormData = require("form-data");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const { killProcess } = require("../utils/process");
const { getSafeTempDir } = require("./safeTempDir");
const { convertToWav } = require("./ffmpegUtils");
const GpuBinaryManager = require("./gpuBinaryManager");

const gpuBinaryManager = new GpuBinaryManager();

const PORT_RANGE_START = 8178;
const PORT_RANGE_END = 8199;
const STARTUP_TIMEOUT_MS = 30000;
const HEALTH_CHECK_INTERVAL_MS = 5000;
const HEALTH_CHECK_TIMEOUT_MS = 2000;
const DEFAULT_INPUT_EXTENSION = ".webm";
const WINDOWS_STATUS_DLL_NOT_FOUND = 3221225781;
const WINDOWS_STATUS_DLL_NOT_FOUND_SIGNED = -1073741515;
const WAV_HEADER_BYTES = 44;
const WHISPER_LONG_AUDIO_THRESHOLD_SECONDS = 20 * 60;
const WHISPER_CHUNK_SECONDS = 60;
const WHISPER_REQUEST_MIN_TIMEOUT_MS = 10 * 60 * 1000;
const WHISPER_REQUEST_MS_PER_AUDIO_SECOND = 3000;
const WHISPER_REQUEST_MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const PROCESS_STARTUP_BUFFER_MAX_CHARS = 64 * 1024;
const ALLOWED_INPUT_EXTENSIONS = new Set([
  ".wav",
  ".mp3",
  ".m4a",
  ".ogg",
  ".flac",
  ".webm",
  ".mp4",
  ".m4v",
  ".mov",
  ".mkv",
  ".avi",
]);

function resolveTempInputExtension(inputFileName) {
  if (!inputFileName || typeof inputFileName !== "string") {
    return DEFAULT_INPUT_EXTENSION;
  }

  const ext = path.extname(inputFileName).toLowerCase();
  if (ALLOWED_INPUT_EXTENSIONS.has(ext)) {
    return ext;
  }

  return DEFAULT_INPUT_EXTENSION;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function appendBoundedText(buffer, text, maxChars = PROCESS_STARTUP_BUFFER_MAX_CHARS) {
  const next = `${buffer}${text}`;
  return next.length > maxChars ? next.slice(-maxChars) : next;
}

function parseWavPcmInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < WAV_HEADER_BYTES) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }

  let offset = 12;
  let format = null;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;

    if (chunkId === "fmt " && chunkDataOffset + 16 <= buffer.length) {
      format = {
        audioFormat: buffer.readUInt16LE(chunkDataOffset),
        channels: buffer.readUInt16LE(chunkDataOffset + 2),
        sampleRate: buffer.readUInt32LE(chunkDataOffset + 4),
        byteRate: buffer.readUInt32LE(chunkDataOffset + 8),
        blockAlign: buffer.readUInt16LE(chunkDataOffset + 12),
        bitsPerSample: buffer.readUInt16LE(chunkDataOffset + 14),
      };
    } else if (chunkId === "data") {
      dataOffset = chunkDataOffset;
      dataSize = Math.min(chunkSize, buffer.length - chunkDataOffset);
      break;
    }

    offset += 8 + chunkSize + (chunkSize % 2);
  }

  if (!format || dataOffset < 0 || dataSize <= 0 || format.byteRate <= 0) return null;

  return {
    ...format,
    dataOffset,
    dataSize,
    durationSeconds: dataSize / format.byteRate,
  };
}

function createPcm16WavBuffer(pcmData, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(WAV_HEADER_BYTES);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcmData.length, 40);

  return Buffer.concat([header, pcmData]);
}

function getWhisperRequestTimeoutMs(durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return WHISPER_REQUEST_MIN_TIMEOUT_MS;
  }

  return clamp(
    Math.ceil(durationSeconds * WHISPER_REQUEST_MS_PER_AUDIO_SECOND),
    WHISPER_REQUEST_MIN_TIMEOUT_MS,
    WHISPER_REQUEST_MAX_TIMEOUT_MS
  );
}

function stripSpeakerTurnTokens(text) {
  return typeof text === "string"
    ? text
        .replace(/\[\s*SPEAKER_TURN\s*\]/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}

function offsetVerboseJsonSegments(result, offsetSeconds) {
  if (!result) {
    return result;
  }
  const cleanedText = stripSpeakerTurnTokens(result.text || "");
  if (!Array.isArray(result.segments)) {
    return cleanedText ? { ...result, text: cleanedText } : result;
  }
  const timestampOffset = Number.isFinite(offsetSeconds) ? offsetSeconds : 0;
  return {
    ...result,
    text: cleanedText,
    segments: result.segments.map((segment) => ({
      ...segment,
      start: typeof segment.start === "number" ? segment.start + timestampOffset : segment.start,
      end: typeof segment.end === "number" ? segment.end + timestampOffset : segment.end,
      text: segment.text,
    })),
  };
}

function mergeVerboseJsonResults(results) {
  const segments = results.flatMap((result) =>
    Array.isArray(result?.segments) ? result.segments : []
  );
  const text = results
    .map((result) => stripSpeakerTurnTokens(result?.text || ""))
    .filter(Boolean)
    .join(" ");
  return { ...results[0], text, segments, chunks: results.length };
}

// Stop whisper-server after a period of inactivity to free GPU/CPU memory
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

class WhisperServerManager {
  constructor() {
    this.process = null;
    this.port = null;
    this.ready = false;
    this.modelPath = null;
    this.loadedModelPath = null;
    this.startupPromise = null;
    this.healthCheckInterval = null;
    this.cachedServerBinaryPath = null;
    this.activeServerBinaryPath = null;
    this.cachedFFmpegPath = null;
    this.canConvert = false;

    // When true, always use the CPU binary even if the CUDA binary is present.
    this.forceCpu = process.env.WHISPER_FORCE_CPU === "true";
    this.cudaDisabledForSession = false;
    this._cudaDisabledAt = null;
    this._lastCudaStartupFailure = null;

    // Idle timeout tracking (for automatic GPU memory cleanup)
    this.lastUsedTime = 0;
    this.idleCheckTimeout = null;
    this.stoppedDueToIdle = false;

    // Configurable idle timeout (ms). Set to 0 to disable auto-stop.
    this.idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;

    this.activeTranscriptions = 0;
    this.stdoutCapture = null;
    this.printRealtimeEnabled = false;
  }

  getFFmpegPath() {
    if (this.cachedFFmpegPath) return this.cachedFFmpegPath;

    try {
      let ffmpegPath = require("ffmpeg-static");
      ffmpegPath = path.normalize(ffmpegPath);

      if (process.platform === "win32" && !ffmpegPath.endsWith(".exe")) {
        ffmpegPath += ".exe";
      }

      // Try unpacked ASAR path first (production builds unpack ffmpeg-static)
      const unpackedPath = ffmpegPath.includes("app.asar")
        ? ffmpegPath.replace(/app\.asar([/\\])/, "app.asar.unpacked$1")
        : null;

      if (unpackedPath && fs.existsSync(unpackedPath)) {
        // Ensure executable permissions on non-Windows
        if (process.platform !== "win32") {
          try {
            fs.accessSync(unpackedPath, fs.constants.X_OK);
          } catch {
            try {
              fs.chmodSync(unpackedPath, 0o755);
            } catch (chmodErr) {
              debugLogger.warn("Failed to chmod FFmpeg", { error: chmodErr.message });
            }
          }
        }
        this.cachedFFmpegPath = unpackedPath;
        return unpackedPath;
      }

      // Try original path (development or if not in ASAR)
      if (fs.existsSync(ffmpegPath)) {
        if (process.platform !== "win32") {
          try {
            fs.accessSync(ffmpegPath, fs.constants.X_OK);
          } catch {
            // Not executable, fall through to system candidates
            debugLogger.debug("FFmpeg exists but not executable", { ffmpegPath });
            throw new Error("Not executable");
          }
        }
        this.cachedFFmpegPath = ffmpegPath;
        return ffmpegPath;
      }
    } catch (err) {
      debugLogger.debug("Bundled FFmpeg not available", { error: err.message });
    }

    // Try system FFmpeg locations
    const systemCandidates =
      process.platform === "darwin"
        ? ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]
        : process.platform === "win32"
          ? ["C:\\ffmpeg\\bin\\ffmpeg.exe"]
          : ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"];

    for (const candidate of systemCandidates) {
      if (fs.existsSync(candidate)) {
        this.cachedFFmpegPath = candidate;
        return candidate;
      }
    }

    const pathEnv = process.env.PATH || "";
    const pathSep = process.platform === "win32" ? ";" : ":";
    const pathDirs = pathEnv.split(pathSep).map((entry) => entry.replace(/^"|"$/g, ""));
    const pathBinary = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

    for (const dir of pathDirs) {
      if (!dir) continue;
      const candidate = path.join(dir, pathBinary);
      if (!fs.existsSync(candidate)) continue;
      if (process.platform !== "win32") {
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
        } catch {
          continue;
        }
      }
      this.cachedFFmpegPath = candidate;
      return candidate;
    }

    debugLogger.debug("FFmpeg not found");
    return null;
  }

  /**
   * Update whether to force CPU mode. Clears the binary path cache and stops
   * any running server so the next transcription starts with the correct binary.
   */
  async setForceCpu(value) {
    const activeBinaryIsWrongForMode =
      this.process &&
      this.activeServerBinaryPath &&
      ((value && this.isCudaServerBinaryPath(this.activeServerBinaryPath)) ||
        (!value &&
          !this.cudaDisabledForSession &&
          gpuBinaryManager.getCudaBinaryPath() &&
          !this.isCudaServerBinaryPath(this.activeServerBinaryPath)));

    const retryCudaAfterPreviousFailure = !value && this.forceCpu && this.cudaDisabledForSession;

    if (this.forceCpu === value && !activeBinaryIsWrongForMode && !retryCudaAfterPreviousFailure) {
      return;
    }
    this.forceCpu = value;
    if (!value) {
      this.cudaDisabledForSession = false;
      this._cudaDisabledAt = null;
      this._lastCudaStartupFailure = null;
    }
    this.cachedServerBinaryPath = null;
    await this.stop();
    debugLogger.info("WhisperServer: forceCpu applied", {
      forceCpu: value,
      stoppedWrongModeServer: !!activeBinaryIsWrongForMode,
      retriedCudaAfterPreviousFailure: retryCudaAfterPreviousFailure,
    });
  }

  async invalidateServerCache({ stopRunningServer = false } = {}) {
    this.cachedServerBinaryPath = null;
    if (stopRunningServer && this.process) {
      await this.stop();
    }
  }

  getServerBinaryPath() {
    if (this.cachedServerBinaryPath) return this.cachedServerBinaryPath;

    if (!this.forceCpu && !this.cudaDisabledForSession) {
      const cudaPath = gpuBinaryManager.getCudaBinaryPath();
      if (cudaPath) {
        debugLogger.info("WhisperServer: using CUDA binary", { cudaPath });
        this.cachedServerBinaryPath = cudaPath;
        return cudaPath;
      }
    } else {
      debugLogger.info("WhisperServer: CUDA binary skipped", {
        reason: this.forceCpu ? "CPU mode forced" : "disabled after startup failure",
      });
    }

    const cpuPath = this.getCpuServerBinaryPath();
    if (cpuPath) this.cachedServerBinaryPath = cpuPath;
    return cpuPath;
  }

  getCpuServerBinaryPath() {
    const platform = process.platform;
    const arch = process.arch;
    const platformArch = `${platform}-${arch}`;
    const binaryName =
      platform === "win32"
        ? `whisper-server-${platformArch}.exe`
        : `whisper-server-${platformArch}`;
    const genericName = platform === "win32" ? "whisper-server.exe" : "whisper-server";

    const candidates = [];

    if (process.resourcesPath) {
      candidates.push(
        path.join(process.resourcesPath, "bin", binaryName),
        path.join(process.resourcesPath, "bin", genericName)
      );
    }

    candidates.push(
      path.join(__dirname, "..", "..", "resources", "bin", binaryName),
      path.join(__dirname, "..", "..", "resources", "bin", genericName)
    );

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        try {
          fs.statSync(candidate);
          this.cachedServerBinaryPath = candidate;
          return candidate;
        } catch {
          // Can't access binary
        }
      }
    }

    return null;
  }

  isCudaServerBinaryPath(serverBinary) {
    return !!serverBinary && /-cuda(?:\.exe)?$/i.test(path.basename(serverBinary));
  }

  isMissingDllStartupFailure(error) {
    const exitCode = error?.exitCode;
    if (
      exitCode === WINDOWS_STATUS_DLL_NOT_FOUND ||
      exitCode === WINDOWS_STATUS_DLL_NOT_FOUND_SIGNED
    ) {
      return true;
    }

    const message = error?.message || "";
    return (
      message.includes(String(WINDOWS_STATUS_DLL_NOT_FOUND)) ||
      message.includes(String(WINDOWS_STATUS_DLL_NOT_FOUND_SIGNED)) ||
      /STATUS_DLL_NOT_FOUND/i.test(message)
    );
  }

  isRecoverableCudaStartupFailure(error) {
    const message = error?.message || "";
    const code = error?.code ? String(error.code).toUpperCase() : "";
    const syscall = error?.syscall ? String(error.syscall).toLowerCase() : "";
    const recoverableSpawnCodes = new Set(["ENOENT", "EACCES", "EPERM", "UNKNOWN"]);

    return (
      this.isMissingDllStartupFailure(error) ||
      recoverableSpawnCodes.has(code) ||
      syscall.startsWith("spawn") ||
      /\bspawn\s+(UNKNOWN|ENOENT|EACCES|EPERM)\b/i.test(message) ||
      message.includes("process died during startup") ||
      message.includes("failed to start within")
    );
  }

  isAvailable() {
    return this.getServerBinaryPath() !== null;
  }

  async findAvailablePort() {
    for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
      if (await this.isPortAvailable(port)) return port;
    }
    throw new Error(`No available ports in range ${PORT_RANGE_START}-${PORT_RANGE_END}`);
  }

  isPortAvailable(port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close();
        resolve(true);
      });
      server.listen(port, "127.0.0.1");
    });
  }

  async start(modelPath, options = {}) {
    // Fast path: server is already running with the right model and no startup
    // is in progress.  Just bump the usage timestamp and return immediately.
    const wantsPrintRealtime = options.printRealtime === true;
    if (
      this.ready &&
      this.loadedModelPath === modelPath &&
      this.printRealtimeEnabled === wantsPrintRealtime &&
      !this.startupPromise
    ) {
      this.lastUsedTime = Date.now();
      this.stoppedDueToIdle = false;
      this._scheduleIdleCheck();
      return;
    }

    // If a startup is already in-flight for this exact model, share the promise
    // so the second caller waits for the same result instead of spawning again.
    if (
      this.startupPromise &&
      this.modelPath === modelPath &&
      this.printRealtimeEnabled === wantsPrintRealtime
    ) {
      return this.startupPromise;
    }

    // A different model was requested (or no startup was in progress).
    // We must serialise through the existing in-flight promise (if any) so that
    // we never run _doStart concurrently.  Assign both startupPromise and
    // modelPath *before* any await so that a concurrent caller arriving while
    // we are awaiting stop() or _doStart() will see the new values and share
    // this promise rather than spawning a second server process.
    const prev = this.startupPromise ?? Promise.resolve();
    this.modelPath = modelPath; // claim the slot early

    const startup = prev
      .catch(() => {}) // don't let a failed previous startup block the new one
      .then(async () => {
        // Re-check after the previous promise settled: the server may have
        // become ready for this model (e.g. from a concurrent caller).
        if (
          this.ready &&
          this.loadedModelPath === modelPath &&
          this.printRealtimeEnabled === wantsPrintRealtime
        ) {
          this.lastUsedTime = Date.now();
          this.stoppedDueToIdle = false;
          this._scheduleIdleCheck();
          return;
        }
        if (this.process) await this.stop();
        await this._doStart(modelPath, options);
      });

    this.startupPromise = startup;

    return startup.finally(() => {
      // Only clear the slot if nothing newer has claimed it.
      if (this.startupPromise === startup) {
        this.startupPromise = null;
      }
    });
  }

  async _doStart(modelPath, options = {}) {
    const serverBinary = this.getServerBinaryPath();
    if (!serverBinary) throw new Error("whisper-server binary not found");
    if (!fs.existsSync(modelPath)) throw new Error(`Model file not found: ${modelPath}`);

    try {
      await this._startWithBinary(serverBinary, modelPath, options);
      if (this.isCudaServerBinaryPath(serverBinary)) {
        this._lastCudaStartupFailure = null;
      }
    } catch (error) {
      if (
        !this.isCudaServerBinaryPath(serverBinary) ||
        !this.isRecoverableCudaStartupFailure(error)
      ) {
        throw error;
      }

      if (this.isMissingDllStartupFailure(error)) {
        debugLogger.warn("CUDA binary failed (missing DLLs), falling back to CPU binary", {
          cudaPath: serverBinary,
          error: error.message,
          exitCode: error.exitCode,
        });
      } else {
        debugLogger.warn("CUDA binary failed during startup, falling back to CPU binary", {
          cudaPath: serverBinary,
          error: error.message,
          exitCode: error.exitCode,
        });
      }

      this.cudaDisabledForSession = true;
      this._cudaDisabledAt = Date.now();
      this._lastCudaStartupFailure = {
        kind: this.isMissingDllStartupFailure(error) ? "missing_dll_or_runtime" : "startup_failure",
        message: error.message || String(error),
        code: error.code || null,
        exitCode: error.exitCode ?? null,
        syscall: error.syscall || null,
      };
      this.cachedServerBinaryPath = null;

      const cpuBinary = this.getCpuServerBinaryPath();
      if (!cpuBinary) {
        throw error;
      }

      this.cachedServerBinaryPath = cpuBinary;
      try {
        await this._startWithBinary(cpuBinary, modelPath, options);
      } catch (cpuError) {
        debugLogger.error("CPU binary fallback failed after CUDA startup failure", {
          cudaPath: serverBinary,
          cpuPath: cpuBinary,
          cudaError: error.message,
          cudaExitCode: error.exitCode,
          cpuError: cpuError.message,
          cpuExitCode: cpuError.exitCode,
        });
        throw new Error(
          `Local transcription failed: GPU binary failed (missing CUDA runtime) and CPU binary also failed: ${cpuError.message}`
        );
      }
    }
  }

  async _startWithBinary(serverBinary, modelPath, options = {}) {
    this.port = await this.findAvailablePort();
    this.modelPath = modelPath;

    // Check for FFmpeg first - only use --convert flag if FFmpeg is available
    const ffmpegPath = this.getFFmpegPath();
    const spawnEnv = { ...process.env };
    const pathSep = process.platform === "win32" ? ";" : ":";

    if (process.platform === "win32") {
      const safeTmp = getSafeTempDir();
      spawnEnv.TEMP = safeTmp;
      spawnEnv.TMP = safeTmp;
    }

    // Add the whisper-server directory to PATH so any companion DLLs are found
    const serverBinaryDir = path.dirname(serverBinary);
    spawnEnv.PATH = serverBinaryDir + pathSep + (process.env.PATH || "");
    if (process.platform !== "win32") {
      spawnEnv.LD_LIBRARY_PATH = serverBinaryDir + pathSep + (process.env.LD_LIBRARY_PATH || "");
    }

    const args = ["--model", modelPath, "--host", "127.0.0.1", "--port", String(this.port)];

    // FFmpeg is required for pre-converting audio to 16kHz mono WAV
    this.canConvert = !!ffmpegPath;
    if (ffmpegPath) {
      const ffmpegDir = path.dirname(ffmpegPath);
      spawnEnv.PATH = ffmpegDir + pathSep + spawnEnv.PATH;
    } else {
      debugLogger.warn("FFmpeg not found - whisper-server will only accept 16kHz mono WAV");
    }

    // Reduce repetition hallucinations: lower entropy threshold triggers
    // temperature fallback sooner when the decoder enters a loop, and
    // suppress-nst filters out non-speech tokens that often seed loops.
    // --no-fallback was tested but had no effect on repeated-word clips —
    // the slowness is in the first decode pass, not temperature fallback retries.
    args.push("--entropy-thold", "2.0");
    args.push("--suppress-nst");

    if (options.threads) args.push("--threads", String(options.threads));
    if (options.printRealtime) {
      args.push("--print-realtime");
      args.push("--tinydiarize");
    }
    // whisper.cpp defaults to English in some server builds when language is omitted.
    // Pass auto explicitly so multilingual/local-file transcription really auto-detects.
    args.push(
      "--language",
      options.language && options.language !== "auto" ? options.language : "auto"
    );

    debugLogger.debug("Starting whisper-server", {
      port: this.port,
      modelPath,
      serverBinary,
      args,
      cwd: serverBinaryDir,
    });

    let stderrBuffer = "";
    let exitCode = null;
    let startupError = null;

    try {
      this.process = spawn(serverBinary, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: spawnEnv,
        cwd: serverBinaryDir,
      });
    } catch (error) {
      debugLogger.error("whisper-server spawn failed", {
        error: error.message,
        code: error.code,
        errno: error.errno,
        syscall: error.syscall,
        serverBinary,
      });
      throw error;
    }

    this.process.stdout.on("data", (data) => {
      const text = data.toString();
      if (this.stdoutCapture !== null) this.stdoutCapture += text;
      debugLogger.debug("whisper-server stdout", { data: text.trim() });
    });

    this.process.stderr.on("data", (data) => {
      const text = data.toString();
      stderrBuffer = appendBoundedText(stderrBuffer, text);
      if (this.stdoutCapture !== null) this.stdoutCapture += text;
      debugLogger.debug("whisper-server stderr", { data: text.trim() });
    });

    this.process.on("error", (error) => {
      startupError = error;
      debugLogger.error("whisper-server process error", {
        error: error.message,
        code: error.code,
        errno: error.errno,
        syscall: error.syscall,
        serverBinary,
      });
      this.ready = false;
    });

    this.process.on("close", (code) => {
      exitCode = code;
      debugLogger.debug("whisper-server process exited", { code });
      this.ready = false;
      this.printRealtimeEnabled = false;
      this.stdoutCapture = null;
      this.process = null;
      this.activeServerBinaryPath = null;
      this.loadedModelPath = null;
      this.stopHealthCheck();
      this._clearIdleCheck();
    });

    try {
      await this.waitForReady(() => ({ stderr: stderrBuffer, exitCode, startupError }));
      this.printRealtimeEnabled = options.printRealtime === true;
      this.loadedModelPath = modelPath;
      this.modelPath = modelPath;
    } catch (error) {
      debugLogger.error("whisper-server failed readiness check", {
        error: error.message,
        serverBinary,
        exitCode: error.exitCode,
      });
      await this.stop();
      throw error;
    }

    this.startHealthCheck();

    this.activeServerBinaryPath = serverBinary;

    // Initialize idle timer on successful start.
    this.lastUsedTime = Date.now();
    this.stoppedDueToIdle = false;
    this._scheduleIdleCheck();

    debugLogger.info("whisper-server started successfully", {
      port: this.port,
      model: path.basename(modelPath),
      modelPath,
      pid: this.process?.pid || null,
      serverBinary,
    });
  }

  async waitForReady(getProcessInfo) {
    const startTime = Date.now();
    let pollCount = 0;

    // Poll every 100ms during startup (faster than ongoing health checks at 5000ms)
    // This saves 0-400ms average vs 500ms polling
    const STARTUP_POLL_INTERVAL_MS = 100;

    while (Date.now() - startTime < STARTUP_TIMEOUT_MS) {
      const info = getProcessInfo ? getProcessInfo() : {};

      if (info.startupError) {
        const error = info.startupError;
        const stderr = info.stderr ? info.stderr.trim().slice(0, 200) : "";
        if (stderr && !error.stderr) error.stderr = stderr;
        if (info.exitCode !== null && error.exitCode === undefined) {
          error.exitCode = info.exitCode;
        }
        throw error;
      }

      if (!this.process || this.process.killed) {
        const stderr = info.stderr ? info.stderr.trim().slice(0, 200) : "";
        const details = stderr || (info.exitCode !== null ? `exit code: ${info.exitCode}` : "");
        const error = new Error(
          `whisper-server process died during startup${details ? `: ${details}` : ""}`
        );
        error.exitCode = info.exitCode;
        error.stderr = stderr;
        throw error;
      }

      pollCount++;
      if (await this.checkHealth()) {
        this.ready = true;
        debugLogger.debug("whisper-server ready", {
          startupTimeMs: Date.now() - startTime,
          pollCount,
        });
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_INTERVAL_MS));
    }

    throw new Error(`whisper-server failed to start within ${STARTUP_TIMEOUT_MS}ms`);
  }

  checkHealth() {
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: "/",
          method: "GET",
          timeout: HEALTH_CHECK_TIMEOUT_MS,
        },
        (res) => {
          resolve(true);
          res.resume();
        }
      );

      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  startHealthCheck() {
    this.stopHealthCheck();
    this.healthCheckInterval = setInterval(async () => {
      if (!this.process) {
        this.stopHealthCheck();
        return;
      }
      if (!(await this.checkHealth())) {
        debugLogger.warn("whisper-server health check failed");
        this.ready = false;
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  _clearIdleCheck() {
    if (this.idleCheckTimeout) {
      clearTimeout(this.idleCheckTimeout);
      this.idleCheckTimeout = null;
    }
  }

  _scheduleIdleCheck() {
    this._clearIdleCheck();

    // If never used yet or not running, don't schedule.
    if (!this.process || !this.ready) return;
    if (!this.lastUsedTime) this.lastUsedTime = Date.now();

    const now = Date.now();
    const idleForMs = now - this.lastUsedTime;
    const effectiveTimeout = this.idleTimeoutMs || 0;

    // Disabled => never schedule.
    if (effectiveTimeout <= 0) return;

    const remainingMs = Math.max(0, effectiveTimeout - idleForMs);

    this.idleCheckTimeout = setTimeout(() => {
      // Fire-and-forget. If it errors, we just log.
      this.checkIdleAndStop().catch((err) => {
        debugLogger.warn("Idle check failed", { error: err.message });
      });
    }, remainingMs);
  }

  async checkIdleAndStop() {
    // No process => nothing to do.
    if (!this.process || !this.ready) return false;

    if (this.activeTranscriptions > 0) {
      this.lastUsedTime = Date.now();
      this.stoppedDueToIdle = false;
      this._scheduleIdleCheck();
      return false;
    }

    const now = Date.now();
    const last = this.lastUsedTime || 0;
    const idleForMs = now - last;

    const effectiveTimeout = this.idleTimeoutMs || 0;
    if (effectiveTimeout <= 0) return false;

    if (idleForMs < effectiveTimeout) {
      // Still active enough; reschedule next check.
      this._scheduleIdleCheck();
      return false;
    }

    debugLogger.info("Stopping whisper-server due to inactivity", {
      idleForMs,
      idleTimeoutMs: effectiveTimeout,
    });

    this.stoppedDueToIdle = true;
    await this.stop();
    return true;
  }

  setIdleTimeoutMs(ms) {
    const parsed = Number(ms);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error("Invalid idle timeout");
    }
    this.idleTimeoutMs = parsed;

    // Reschedule with new timeout immediately.
    if (this.process && this.ready) {
      this._scheduleIdleCheck();
    }

    debugLogger.info("Updated whisper-server idle timeout", {
      idleTimeoutMs: this.idleTimeoutMs,
    });

    return { success: true, idleTimeoutMs: this.idleTimeoutMs };
  }

  isProcessing() {
    return this.activeTranscriptions > 0;
  }

  async transcribe(audioBuffer, options = {}) {
    if (!this.ready || !this.process) {
      throw new Error("whisper-server is not running");
    }
    this.activeTranscriptions += 1;
    this.lastUsedTime = Date.now();
    this.stoppedDueToIdle = false;
    this._scheduleIdleCheck();

    // Debug: Log audio buffer info
    debugLogger.debug("whisper-server transcribe called", {
      bufferLength: audioBuffer?.length || 0,
      bufferType: audioBuffer?.constructor?.name,
      firstBytes:
        audioBuffer?.length >= 16
          ? Array.from(audioBuffer.slice(0, 16))
              .map((b) => b.toString(16).padStart(2, "0"))
              .join(" ")
          : "too short",
    });

    try {
      const {
        language,
        translate,
        initialPrompt,
        inputFileName,
        fileMode = false,
        noiseReduction = false,
        speakerDetection = false,
        diarize = false,
        vad = false,
        onProgress,
      } = options;

      // Always convert to 16kHz mono WAV - whisper.cpp requires this exact format
      let finalBuffer = audioBuffer;
      if (!this.canConvert) {
        throw new Error("FFmpeg not found - required for audio conversion");
      }

      if (typeof onProgress === "function") {
        onProgress({ stage: "converting", percentage: 0 });
      }

      finalBuffer = await this._convertToWav(audioBuffer, inputFileName, {
        // whisper.cpp stereo diarization needs two channels; tdrz/tinydiarize stays mono.
        channels: fileMode && diarize ? 2 : 1,
        noiseReduction: fileMode && noiseReduction,
      });

      const chunks = this._splitWavIntoTranscriptionChunks(finalBuffer);
      if (chunks.length > 1) {
        debugLogger.info("Long audio detected; transcribing in chunks", {
          chunks: chunks.length,
          totalDurationSeconds: chunks.reduce((sum, chunk) => sum + chunk.durationSeconds, 0),
          chunkSeconds: WHISPER_CHUNK_SECONDS,
        });
      }

      if (typeof onProgress === "function") {
        onProgress({
          stage: "transcribing",
          percentage: 0,
          chunksTotal: chunks.length,
          chunksCompleted: 0,
        });
      }

      const results = [];
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        debugLogger.debug("Submitting whisper-server chunk", {
          chunk: index + 1,
          chunks: chunks.length,
          durationSeconds: Math.round(chunk.durationSeconds),
          sizeBytes: chunk.buffer.length,
        });
        let result;
        try {
          result = await this._postInference(chunk.buffer, {
            language,
            translate,
            initialPrompt,
            chunkIndex: index,
            chunkCount: chunks.length,
            durationSeconds: chunk.durationSeconds,
            fileMode,
            diarize,
            tinydiarize: fileMode && speakerDetection,
            vad,
          });
        } catch (error) {
          if (!fileMode) throw error;
          debugLogger.warn(
            "verbose_json file transcription failed; retrying with json compatibility fallback",
            {
              error: error.message,
              chunk: index + 1,
              chunks: chunks.length,
            }
          );
          const activeModelPath = this.modelPath;
          if (activeModelPath) {
            await this.stop();
            await this.start(activeModelPath);
          }
          result = await this._postInference(chunk.buffer, {
            language,
            translate,
            initialPrompt,
            chunkIndex: index,
            chunkCount: chunks.length,
            durationSeconds: chunk.durationSeconds,
            fileMode: false,
          });
          if (!Array.isArray(result?.segments) && result?.text) {
            result = {
              ...result,
              segments: [{ start: 0, end: chunk.durationSeconds || 0, text: result.text }],
              verboseJsonFallback: true,
            };
          }
        }
        results.push(
          fileMode ? offsetVerboseJsonSegments(result, chunk.offsetSeconds || 0) : result
        );

        if (typeof onProgress === "function") {
          const percentage = Math.round(((index + 1) / chunks.length) * 100);
          onProgress({
            stage: "transcribing",
            percentage,
            chunksTotal: chunks.length,
            chunksCompleted: index + 1,
          });
        }
      }

      if (results.length === 1) return results[0];

      if (fileMode && results.some((result) => Array.isArray(result?.segments))) {
        return mergeVerboseJsonResults(results);
      }

      return {
        text: results
          .map((result) => (typeof result?.text === "string" ? result.text.trim() : ""))
          .filter(Boolean)
          .join(" "),
        chunks: results.length,
      };
    } finally {
      this.activeTranscriptions = Math.max(0, this.activeTranscriptions - 1);
    }
  }

  async convertToDiarizationWav(audioBuffer, inputFileName = null, options = {}) {
    if (!this.canConvert) {
      throw new Error("FFmpeg not found - required for audio conversion");
    }
    return await this._convertToWav(audioBuffer, inputFileName, {
      channels: 1,
      noiseReduction: options.noiseReduction === true,
    });
  }

  _beginStdoutCapture() {
    this.stdoutCapture = "";
  }

  _endStdoutCapture() {
    const captured = this.stdoutCapture || "";
    this.stdoutCapture = null;
    return captured;
  }

  _attachTinydiarizeMarkers(parsed, stdoutText) {
    if (!parsed || !Array.isArray(parsed.segments) || !stdoutText) return parsed;
    const realtimeSegments = stdoutText
      .split(/\r?\n/)
      .filter((line) => /\[\d{2}:\d{2}:\d{2}\.\d{3}\s+-->/.test(line));

    if (realtimeSegments.length === 0) return parsed;

    const segments = parsed.segments.map((segment, index) => {
      const realtimeLine = realtimeSegments[index] || "";
      if (!/\[\s*SPEAKER_TURN\s*\]/i.test(realtimeLine)) return segment;
      const text = String(segment.text || "");
      return /\[\s*SPEAKER_TURN\s*\]/i.test(text)
        ? segment
        : { ...segment, text: `${text} [SPEAKER_TURN]` };
    });

    return { ...parsed, segments, tdrzRealtimeText: stdoutText };
  }

  _postInference(wavBuffer, options = {}) {
    const {
      language,
      translate,
      initialPrompt,
      chunkIndex = 0,
      chunkCount = 1,
      durationSeconds,
      fileMode = false,
      diarize = false,
      tinydiarize = false,
      vad = false,
    } = options;
    const form = new FormData();
    const fileName = chunkCount > 1 ? `audio-part-${chunkIndex + 1}.wav` : "audio.wav";

    form.append("file", wavBuffer, { filename: fileName, contentType: "audio/wav" });

    if (language && language !== "auto") form.append("language", language);
    if (translate) form.append("translate", "true");
    if (initialPrompt) {
      form.append("prompt", initialPrompt);
      debugLogger.info("Using custom dictionary prompt", { prompt: initialPrompt });
    }

    form.append("response_format", fileMode ? "verbose_json" : "json");

    if (fileMode) {
      // Long files are especially prone to Whisper repeating stale context after
      // silence/noise. Keep each request independent and ask whisper.cpp to be
      // more conservative about non-speech so one bad short window does not poison
      // the rest of a 45+ minute upload.
      form.append("no_context", "true");
      form.append("suppress_nst", "true");
      form.append("temperature", "0.0");
      form.append("temperature_inc", "0.0");
      form.append("no_speech_thold", "0.45");
    }

    for (const [name, enabled] of Object.entries({ diarize, tinydiarize, vad })) {
      if (enabled) form.append(name, "true");
    }

    const timeoutMs = getWhisperRequestTimeoutMs(durationSeconds);

    if (tinydiarize) this._beginStdoutCapture();

    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: "/inference",
          method: "POST",
          headers: form.getHeaders(),
          timeout: timeoutMs,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            debugLogger.debug("whisper-server transcription completed", {
              statusCode: res.statusCode,
              elapsed: Date.now() - startTime,
              timeoutMs,
              chunk: chunkIndex + 1,
              chunks: chunkCount,
              responseLength: data.length,
              responsePreview: data.slice(0, 500),
            });

            if (res.statusCode !== 200) {
              reject(new Error(`whisper-server returned status ${res.statusCode}: ${data}`));
              return;
            }

            try {
              let parsed = JSON.parse(data);

              const finish = () => {
                if (tinydiarize) {
                  parsed = this._attachTinydiarizeMarkers(parsed, this._endStdoutCapture());
                }

                this.lastUsedTime = Date.now();
                this.stoppedDueToIdle = false;
                this._scheduleIdleCheck();

                resolve(parsed);
              };

              // whisper.cpp writes tinydiarize speaker-turn markers to realtime stdout,
              // not to verbose_json. The HTTP response can finish before Node has
              // delivered the final stdout chunk, so give the pipe one tick to flush.
              if (tinydiarize) setTimeout(finish, 1200);
              else finish();
            } catch (e) {
              if (tinydiarize) this._endStdoutCapture();
              reject(new Error(`Failed to parse whisper-server response: ${e.message}`));
            }
          });
        }
      );

      req.on("error", (error) => {
        if (tinydiarize) this._endStdoutCapture();
        reject(new Error(`whisper-server request failed: ${error.message}`));
      });
      req.on("timeout", () => {
        if (tinydiarize) this._endStdoutCapture();
        req.destroy();
        reject(
          new Error(
            `whisper-server request timed out after ${Math.round(timeoutMs / 1000)}s while processing ${Math.round(durationSeconds || 0)}s of audio`
          )
        );
      });

      form.pipe(req);
    });
  }

  _splitWavIntoTranscriptionChunks(wavBuffer) {
    const info = parseWavPcmInfo(wavBuffer);
    if (!info || info.durationSeconds <= WHISPER_LONG_AUDIO_THRESHOLD_SECONDS) {
      return [{ buffer: wavBuffer, durationSeconds: info?.durationSeconds || 0 }];
    }

    const bytesPerChunk =
      Math.floor((info.byteRate * WHISPER_CHUNK_SECONDS) / info.blockAlign) * info.blockAlign;
    if (bytesPerChunk <= 0 || bytesPerChunk >= info.dataSize) {
      return [{ buffer: wavBuffer, durationSeconds: info.durationSeconds }];
    }

    const chunks = [];
    const dataEnd = info.dataOffset + info.dataSize;
    for (let start = info.dataOffset; start < dataEnd; start += bytesPerChunk) {
      const end = Math.min(start + bytesPerChunk, dataEnd);
      const alignedEnd = end === dataEnd ? end : end - ((end - info.dataOffset) % info.blockAlign);
      const pcmData = wavBuffer.slice(start, alignedEnd);
      if (pcmData.length === 0) continue;
      chunks.push({
        buffer: createPcm16WavBuffer(pcmData, info.sampleRate, info.channels, info.bitsPerSample),
        durationSeconds: pcmData.length / info.byteRate,
        offsetSeconds: (start - info.dataOffset) / info.byteRate,
      });
    }

    return chunks.length > 0
      ? chunks
      : [{ buffer: wavBuffer, durationSeconds: info.durationSeconds }];
  }

  async _convertToWav(audioBuffer, inputFileName = null, options = {}) {
    const tempDir = getSafeTempDir();
    const tempId = crypto.randomUUID();
    const inputExtension = resolveTempInputExtension(inputFileName);
    const tempInputPath = path.join(tempDir, `whisper-input-${tempId}${inputExtension}`);
    const tempWavPath = path.join(tempDir, `whisper-output-${tempId}.wav`);

    try {
      fs.writeFileSync(tempInputPath, audioBuffer);
      await convertToWav(tempInputPath, tempWavPath, {
        sampleRate: 16000,
        channels: options.channels || 1,
        audioFilters: options.noiseReduction ? ["afftdn=nf=-25"] : [],
      });
      return fs.readFileSync(tempWavPath);
    } finally {
      for (const f of [tempInputPath, tempWavPath]) {
        try {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }

  async stop() {
    this.stopHealthCheck();
    this._clearIdleCheck();

    if (!this.process) {
      this.ready = false;
      return;
    }

    debugLogger.debug("Stopping whisper-server");

    try {
      killProcess(this.process, "SIGTERM");

      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) {
            killProcess(this.process, "SIGKILL");
          }
          resolve();
        }, 5000);

        if (this.process) {
          this.process.once("close", () => {
            clearTimeout(timeout);
            resolve();
          });
        } else {
          clearTimeout(timeout);
          resolve();
        }
      });
    } catch (error) {
      debugLogger.error("Error stopping whisper-server", { error: error.message });
    }

    this.process = null;
    this.ready = false;
    this.port = null;
    this.modelPath = null;
    this.loadedModelPath = null;
    this.activeServerBinaryPath = null;
    this.lastUsedTime = 0;
  }

  getStatus() {
    const activeModelPath = this.loadedModelPath || this.modelPath;
    return {
      available: this.isAvailable(),
      running: this.ready && this.process !== null,
      port: this.port,
      modelPath: activeModelPath,
      modelName: activeModelPath
        ? path.basename(activeModelPath, ".bin").replace("ggml-", "")
        : null,
      forceCpu: this.forceCpu,
      activeServerBinaryPath: this.activeServerBinaryPath,
      activeEngine: this.activeServerBinaryPath
        ? this.isCudaServerBinaryPath(this.activeServerBinaryPath)
          ? "gpu"
          : "cpu"
        : null,
    };
  }

  /**
   * Rich engine status for UI and debugging.
   * Separates desired mode from effective engine and exposes fallback state.
   */
  getEngineStatus() {
    const base = this.getStatus();
    const effectiveEngine = this.activeServerBinaryPath
      ? this.isCudaServerBinaryPath(this.activeServerBinaryPath)
        ? "cuda"
        : "cpu"
      : this.ready
        ? "unknown"
        : "stopped";
    return {
      ...base,
      desiredMode: this.forceCpu ? "cpu" : "gpu",
      effectiveEngine,
      fallback: {
        // Only show fallback when user wants GPU but effective engine is NOT CUDA.
        // Check actual running binary, not just the sticky flag.
        active: !this.forceCpu && effectiveEngine !== "cuda" && this.cudaDisabledForSession,
        reason: this.cudaDisabledForSession ? "cuda_startup_failure" : null,
        since: this._cudaDisabledAt || null,
        diagnostic: this._lastCudaStartupFailure,
      },
      transition: this.startupPromise
        ? "starting"
        : this.activeTranscriptions > 0
          ? "transcribing"
          : this.ready
            ? "idle"
            : "stopped",
      activeTranscriptions: this.activeTranscriptions,
      stoppedDueToIdle: this.stoppedDueToIdle || false,
    };
  }
}

module.exports = WhisperServerManager;
