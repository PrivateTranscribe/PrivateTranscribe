/**
 * WindowsKeyManager - Handles key up/down detection for Push-to-Talk on Windows
 *
 * Uses a native Windows keyboard hook to detect when specific keys are
 * pressed and released, enabling Push-to-Talk functionality.
 */

const { spawn } = require("child_process");
const path = require("path");
const EventEmitter = require("events");
const fs = require("fs");
const debugLogger = require("./debugLogger");

const isDiagFlagEnabled = (name) => {
  const raw = String(process.env[name] || "")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
};

function normalizeForWindowsListener(key) {
  if (!key || typeof key !== "string") return key;
  const parts = key.split("+").map((part) => part.trim());
  const base = parts.pop();
  const normalizedBase = base === "½" || base === "`" ? "Backquote" : base;
  return [...parts, normalizedBase].filter(Boolean).join("+");
}

class WindowsKeyManager extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.isSupported = process.platform === "win32";
    this.hasReportedError = false;
    this.currentKey = null;
    this.isReady = false;
    this.isStopping = false;
  }

  /**
   * Start listening for the specified key
   * @param {string} key - The key to listen for (e.g., "`", "F8", "F11", "CommandOrControl+F11")
   */
  start(key = "`") {
    if (!this.isSupported) {
      return;
    }

    if (isDiagFlagEnabled("PRIVATETRANSCRIBE_DIAG_DISABLE_WINDOWS_KEY_LISTENER")) {
      debugLogger.warn("[Diagnostics] Windows native key listener start skipped");
      this.stop();
      return;
    }

    // If already running with the same key, do nothing
    if (this.process && this.currentKey === key) {
      return;
    }

    // Stop any existing listener
    this.stop();

    const listenerPath = this.resolveListenerBinary();
    if (!listenerPath) {
      // Binary not found - this is OK, Push-to-Talk will use fallback mode
      this.emit("unavailable", new Error("Windows key listener binary not found"));
      return;
    }

    const listenerKey = normalizeForWindowsListener(key);

    this.hasReportedError = false;
    this.isReady = false;
    this.isStopping = false;
    this.currentKey = key;

    debugLogger.debug("[WindowsKeyManager] Starting key listener", {
      key,
      listenerKey,
      binaryPath: listenerPath,
    });

    try {
      const child = spawn(listenerPath, [listenerKey], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      this.process = child;
    } catch (error) {
      debugLogger.error("[WindowsKeyManager] Failed to spawn process", { error: error.message });
      this.reportError(error);
      return;
    }

    const listenerProcess = this.process;
    listenerProcess.stdout.setEncoding("utf8");
    listenerProcess.stdout.on("data", (chunk) => {
      chunk
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((line) => {
          if (line === "READY") {
            debugLogger.debug("[WindowsKeyManager] Listener ready", { key });
            this.isReady = true;
            this.emit("ready");
          } else if (line === "KEY_DOWN") {
            debugLogger.debug("[WindowsKeyManager] KEY_DOWN detected", { key });
            this.emit("key-down", key);
          } else if (line === "KEY_UP") {
            debugLogger.debug("[WindowsKeyManager] KEY_UP detected", { key });
            this.emit("key-up", key);
          } else {
            // Log unknown output at debug level (could be native binary's stderr info)
            debugLogger.debug("[WindowsKeyManager] Unknown output", { line });
          }
        });
    });

    listenerProcess.stderr.setEncoding("utf8");
    listenerProcess.stderr.on("data", (data) => {
      const message = data.toString().trim();
      if (message.length > 0) {
        // Native binary logs to stderr for info messages, don't treat as error
        debugLogger.debug("[WindowsKeyManager] Native stderr", { message });
      }
    });

    listenerProcess.on("error", (error) => {
      if (this.process !== listenerProcess) {
        return;
      }
      this.reportError(error);
      this.process = null;
    });

    listenerProcess.on("exit", (code, signal) => {
      const isCurrentProcess = this.process === listenerProcess;
      if (isCurrentProcess) {
        this.process = null;
        this.isReady = false;
      }

      const isExpectedStop = signal === "SIGTERM" || signal === "SIGINT";
      if (!isExpectedStop && code !== 0 && isCurrentProcess) {
        const error = new Error(
          `Windows key listener exited with code ${code ?? "null"} signal ${signal ?? "null"}`
        );
        this.reportError(error);
      }
      if (isCurrentProcess) {
        this.isStopping = false;
      }
    });
  }

  /**
   * Stop the key listener
   */
  stop() {
    if (this.process) {
      debugLogger.debug("[WindowsKeyManager] Stopping key listener");
      this.isStopping = true;
      try {
        this.process.kill();
      } catch {
        // Ignore kill errors
      }
      this.process = null;
    }
    this.isReady = false;
    this.currentKey = null;
  }

  /**
   * Check if the listener is available and ready
   */
  isAvailable() {
    return this.resolveListenerBinary() !== null;
  }

  /**
   * Report an error (only once per session to avoid log spam)
   */
  reportError(error) {
    if (this.hasReportedError) {
      return;
    }
    this.hasReportedError = true;

    if (this.process) {
      try {
        this.process.kill();
      } catch {
        // Ignore
      } finally {
        this.process = null;
      }
    }

    debugLogger.warn("[WindowsKeyManager] Error occurred", { error: error.message });
    this.emit("error", error);
  }

  /**
   * Find the listener binary in various possible locations
   */
  resolveListenerBinary() {
    const binaryName = "windows-key-listener.exe";
    const candidates = new Set([
      path.join(__dirname, "..", "..", "resources", "bin", binaryName),
      path.join(__dirname, "..", "..", "resources", binaryName),
    ]);

    if (process.resourcesPath) {
      [
        path.join(process.resourcesPath, binaryName),
        path.join(process.resourcesPath, "bin", binaryName),
        path.join(process.resourcesPath, "resources", binaryName),
        path.join(process.resourcesPath, "resources", "bin", binaryName),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", binaryName),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", binaryName),
      ].forEach((candidate) => candidates.add(candidate));
    }

    const candidatePaths = [...candidates];

    for (const candidate of candidatePaths) {
      try {
        const stats = fs.statSync(candidate);
        if (stats.isFile()) {
          return candidate;
        }
      } catch {
        continue;
      }
    }

    return null;
  }
}

module.exports = WindowsKeyManager;
