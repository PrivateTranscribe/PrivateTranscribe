const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");
const http = require("http");
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

// Stop whisper-server after a period of inactivity to free GPU/CPU memory
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

class WhisperServerManager {
  constructor() {
    this.process = null;
    this.port = null;
    this.ready = false;
    this.modelPath = null;
    this.startupPromise = null;
    this.healthCheckInterval = null;
    this.cachedServerBinaryPath = null;
    this.cachedFFmpegPath = null;
    this.canConvert = false;

    // When true, always use the CPU binary even if the CUDA binary is present.
    this.forceCpu = process.env.WHISPER_FORCE_CPU === "true";

    // Idle timeout tracking (for automatic GPU memory cleanup)
    this.lastUsedTime = 0;
    this.idleCheckTimeout = null;
    this.stoppedDueToIdle = false;

    // Configurable idle timeout (ms). Set to 0 to disable auto-stop.
    this.idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
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
    if (this.forceCpu === value) return;
    this.forceCpu = value;
    this.cachedServerBinaryPath = null;
    await this.stop();
    debugLogger.info("WhisperServer: forceCpu changed", { forceCpu: value });
  }

  async invalidateServerCache({ stopRunningServer = false } = {}) {
    this.cachedServerBinaryPath = null;
    if (stopRunningServer && this.process) {
      await this.stop();
    }
  }

  getServerBinaryPath() {
    if (this.cachedServerBinaryPath) return this.cachedServerBinaryPath;

    if (!this.forceCpu) {
      const cudaPath = gpuBinaryManager.getCudaBinaryPath();
      if (cudaPath) {
        debugLogger.info("WhisperServer: using CUDA binary", { cudaPath });
        this.cachedServerBinaryPath = cudaPath;
        return cudaPath;
      }
    } else {
      debugLogger.info("WhisperServer: CUDA binary skipped (CPU mode forced)");
    }

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
    if (this.ready && this.modelPath === modelPath && !this.startupPromise) {
      this.lastUsedTime = Date.now();
      this.stoppedDueToIdle = false;
      this._scheduleIdleCheck();
      return;
    }

    // If a startup is already in-flight for this exact model, share the promise
    // so the second caller waits for the same result instead of spawning again.
    if (this.startupPromise && this.modelPath === modelPath) {
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
        if (this.ready && this.modelPath === modelPath) {
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
    if (options.language && options.language !== "auto") {
      args.push("--language", options.language);
    }

    debugLogger.debug("Starting whisper-server", {
      port: this.port,
      modelPath,
      args,
      cwd: serverBinaryDir,
    });

    this.process = spawn(serverBinary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: spawnEnv,
      cwd: serverBinaryDir,
    });

    let stderrBuffer = "";
    let exitCode = null;

    this.process.stdout.on("data", (data) => {
      debugLogger.debug("whisper-server stdout", { data: data.toString().trim() });
    });

    this.process.stderr.on("data", (data) => {
      stderrBuffer += data.toString();
      debugLogger.debug("whisper-server stderr", { data: data.toString().trim() });
    });

    this.process.on("error", (error) => {
      debugLogger.error("whisper-server process error", { error: error.message });
      this.ready = false;
    });

    this.process.on("close", (code) => {
      exitCode = code;
      debugLogger.debug("whisper-server process exited", { code });
      this.ready = false;
      this.process = null;
      this.stopHealthCheck();
      this._clearIdleCheck();
    });

    await this.waitForReady(() => ({ stderr: stderrBuffer, exitCode }));
    this.startHealthCheck();

    // Initialize idle timer on successful start.
    this.lastUsedTime = Date.now();
    this.stoppedDueToIdle = false;
    this._scheduleIdleCheck();

    debugLogger.info("whisper-server started successfully", {
      port: this.port,
      model: path.basename(modelPath),
    });
  }

  async waitForReady(getProcessInfo) {
    const startTime = Date.now();
    let pollCount = 0;

    // Poll every 100ms during startup (faster than ongoing health checks at 5000ms)
    // This saves 0-400ms average vs 500ms polling
    const STARTUP_POLL_INTERVAL_MS = 100;

    while (Date.now() - startTime < STARTUP_TIMEOUT_MS) {
      if (!this.process || this.process.killed) {
        const info = getProcessInfo ? getProcessInfo() : {};
        const stderr = info.stderr ? info.stderr.trim().slice(0, 200) : "";
        const details = stderr || (info.exitCode !== null ? `exit code: ${info.exitCode}` : "");
        throw new Error(
          `whisper-server process died during startup${details ? `: ${details}` : ""}`
        );
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

  async transcribe(audioBuffer, options = {}) {
    if (!this.ready || !this.process) {
      throw new Error("whisper-server is not running");
    }

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

    const { language, translate, initialPrompt, inputFileName } = options;

    // Always convert to 16kHz mono WAV - whisper.cpp requires this exact format
    let finalBuffer = audioBuffer;
    if (!this.canConvert) {
      throw new Error("FFmpeg not found - required for audio conversion");
    }
    finalBuffer = await this._convertToWav(audioBuffer, inputFileName);

    const boundary = `----WhisperBoundary${Date.now()}`;
    const parts = [];
    const fileName = "audio.wav";
    const contentType = "audio/wav";

    parts.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`
    );
    parts.push(finalBuffer);
    parts.push("\r\n");

    if (language && language !== "auto") {
      parts.push(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="language"\r\n\r\n` +
          `${language}\r\n`
      );
    }

    // Translate to English when explicitly enabled by the user
    if (translate) {
      parts.push(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="translate"\r\n\r\n` +
          `true\r\n`
      );
    }

    // Add initial prompt for custom dictionary words
    if (initialPrompt) {
      parts.push(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="prompt"\r\n\r\n` +
          `${initialPrompt}\r\n`
      );
      debugLogger.info("Using custom dictionary prompt", { prompt: initialPrompt });
    }

    parts.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
        `json\r\n`
    );
    parts.push(`--${boundary}--\r\n`);

    const bodyParts = parts.map((part) => (typeof part === "string" ? Buffer.from(part) : part));
    const body = Buffer.concat(bodyParts);

    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: "/inference",
          method: "POST",
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": body.length,
          },
          timeout: 300000,
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
              responseLength: data.length,
              responsePreview: data.slice(0, 500),
            });

            if (res.statusCode !== 200) {
              reject(new Error(`whisper-server returned status ${res.statusCode}: ${data}`));
              return;
            }

            try {
              const parsed = JSON.parse(data);

              // Mark server as used on successful transcription.
              this.lastUsedTime = Date.now();
              this.stoppedDueToIdle = false;
              this._scheduleIdleCheck();
              // Ensure idle shutdown logic is engaged (fire-and-forget).
              this.checkIdleAndStop().catch(() => {});

              resolve(parsed);
            } catch (e) {
              reject(new Error(`Failed to parse whisper-server response: ${e.message}`));
            }
          });
        }
      );

      req.on("error", (error) => {
        reject(new Error(`whisper-server request failed: ${error.message}`));
      });
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("whisper-server request timed out"));
      });

      req.write(body);
      req.end();
    });
  }

  async _convertToWav(audioBuffer, inputFileName = null) {
    const tempDir = getSafeTempDir();
    const tempId = crypto.randomUUID();
    const inputExtension = resolveTempInputExtension(inputFileName);
    const tempInputPath = path.join(tempDir, `whisper-input-${tempId}${inputExtension}`);
    const tempWavPath = path.join(tempDir, `whisper-output-${tempId}.wav`);

    try {
      fs.writeFileSync(tempInputPath, audioBuffer);
      await convertToWav(tempInputPath, tempWavPath, { sampleRate: 16000, channels: 1 });
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
    this.lastUsedTime = 0;
  }

  getStatus() {
    return {
      available: this.isAvailable(),
      running: this.ready && this.process !== null,
      port: this.port,
      modelPath: this.modelPath,
      modelName: this.modelPath ? path.basename(this.modelPath, ".bin").replace("ggml-", "") : null,
    };
  }
}

module.exports = WhisperServerManager;
