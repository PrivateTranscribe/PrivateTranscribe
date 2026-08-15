"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const unzipper = require("unzipper");
const { pipeline } = require("stream/promises");
const { app } = require("electron");
const debugLogger = require("./debugLogger");
const { downloadFile, createDownloadSignal, isRetryable } = require("./downloadUtils");

// R2 public CDN — binaries served directly (no zip extraction needed)
const R2_BASE_URL = "https://updates.privatetranscribe.com";
// v0.0.10 is the first Authenticode-signed engine. v0.0.9 and earlier are
// unsigned, which Windows Smart App Control blocks outright — the spawn fails
// on every attempt and the app is stuck in CPU fallback with no way to recover.
// Bumping (rather than republishing v0.0.9) is what makes existing installs
// re-download: they record the installed version and would otherwise consider
// themselves current.
const BINARY_VERSION = "v0.0.10";
const USER_AGENT = "PrivateTranscribe/1.0";
const CUDA_VERSION_FILE = "whisper-server-cuda-version.txt";
const MIN_CUDA_LAUNCHER_BYTES = 100_000;
const MIN_CUDA_PACKAGE_BYTES = 10_000_000;

// Published by the build-cuda-binary CI workflow after every engine upload.
// The engine an app build installs stays pinned to BINARY_VERSION (engines are
// validated per app release), but the manifest lets older builds *see* that a
// newer engine exists so Settings can say "ships with the next app update".
const LATEST_MANIFEST_URL = `${R2_BASE_URL}/binaries/latest-cuda.json`;
const LATEST_MANIFEST_TIMEOUT_MS = 5000;
const LATEST_MANIFEST_CACHE_MS = 60 * 60 * 1000; // successful lookups
const LATEST_MANIFEST_RETRY_MS = 5 * 60 * 1000; // failed lookups (offline, 404)
const ENGINE_VERSION_PATTERN = /^v\d+\.\d+\.\d+$/;

const CUDA_BINARIES = {
  "linux-x64": {
    outputName: "whisper-server-linux-x64-cuda",
    archiveName: "whisper-server-linux-x64-cuda.zip",
    remoteUrl: `${R2_BASE_URL}/binaries/${BINARY_VERSION}/whisper-server-linux-x64-cuda.zip`,
    companionPattern: /\.so(?:\.\d+)*$/,
    approxBytes: 300000000, // CUDA server + runtime libs package
  },
  "win32-x64": {
    outputName: "whisper-server-win32-x64-cuda.exe",
    archiveName: "whisper-server-win32-x64-cuda.zip",
    remoteUrl: `${R2_BASE_URL}/binaries/${BINARY_VERSION}/whisper-server-win32-x64-cuda.zip`,
    companionPattern: /\.dll$/i,
    approxBytes: 700000000, // CUDA server + cudart/cublas DLL package
  },
};

class GpuBinaryManager {
  constructor() {
    this._abortController = null;
    this._latestVersionCache = null;
    // In-flight download shared by every caller. A download can be started by
    // the silent startup auto-update, by Settings, or by onboarding; they all
    // want the same file, so they join one download rather than racing.
    this._downloadPromise = null;
    this._downloading = false;
    this._lastProgress = null;
    this._progressSubscribers = new Set();
    this._progressListener = null;
  }

  /**
   * Registers the single app-wide progress listener (the IPC layer, which
   * broadcasts to every window). Progress is emitted for *all* downloads,
   * including ones no window asked for, so the UI can never show "Update
   * available" while the update is already running.
   */
  setDownloadProgressListener(listener) {
    this._progressListener = typeof listener === "function" ? listener : null;
  }

  /**
   * Snapshot of any download currently running, for windows that opened after
   * it started and so missed the progress events.
   */
  getDownloadState() {
    if (!this._downloading) return { downloading: false, progress: null };
    return {
      downloading: true,
      progress: this._lastProgress || { phase: "downloading", percent: 0 },
    };
  }

  _emitProgress(progress) {
    this._lastProgress = progress;
    for (const subscriber of this._progressSubscribers) {
      try {
        subscriber(progress);
      } catch {
        /* a failing subscriber must never abort the download */
      }
    }
    if (this._progressListener) {
      try {
        this._progressListener(progress);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Returns the newest CUDA engine version published on the update CDN, or
   * null when unknown (offline, manifest missing, malformed). Results are
   * cached in memory; this never affects which version gets installed —
   * downloads stay pinned to BINARY_VERSION.
   */
  async fetchLatestAvailableVersion() {
    const now = Date.now();
    if (this._latestVersionCache && now < this._latestVersionCache.expiresAt) {
      return this._latestVersionCache.value;
    }

    let value = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LATEST_MANIFEST_TIMEOUT_MS);
      try {
        const response = await fetch(LATEST_MANIFEST_URL, {
          signal: controller.signal,
          headers: { "user-agent": USER_AGENT },
          cache: "no-store",
        });
        if (response.ok) {
          const manifest = await response.json();
          const version = typeof manifest?.version === "string" ? manifest.version.trim() : "";
          if (ENGINE_VERSION_PATTERN.test(version)) {
            value = version;
          } else {
            debugLogger.warn("GpuBinaryManager: latest-cuda manifest has invalid version", {
              version,
            });
          }
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      debugLogger.debug("GpuBinaryManager: latest-cuda manifest lookup failed", {
        error: error?.message || String(error),
      });
    }

    this._latestVersionCache = {
      value,
      expiresAt: now + (value ? LATEST_MANIFEST_CACHE_MS : LATEST_MANIFEST_RETRY_MS),
    };
    return value;
  }

  getBundledBinDir() {
    if (process.resourcesPath) {
      return path.join(process.resourcesPath, "bin");
    }
    return path.join(__dirname, "..", "..", "resources", "bin");
  }

  getBinDir() {
    if (app?.getPath) {
      return path.join(app.getPath("userData"), "bin");
    }
    return this.getBundledBinDir();
  }

  getPlatformKey() {
    return `${process.platform}-${process.arch}`;
  }

  getCudaBinaryFilePath() {
    const key = this.getPlatformKey();
    const spec = CUDA_BINARIES[key];
    if (!spec) return null;

    const binPath = path.join(this.getBinDir(), spec.outputName);
    if (fs.existsSync(binPath)) {
      try {
        fs.statSync(binPath);
        return binPath;
      } catch {
        return null;
      }
    }
    return null;
  }

  getLegacyCudaBinaryPath() {
    const key = this.getPlatformKey();
    const spec = CUDA_BINARIES[key];
    if (!spec) return null;

    const legacyPath = path.join(this.getBundledBinDir(), spec.outputName);
    if (fs.existsSync(legacyPath)) {
      try {
        fs.statSync(legacyPath);
        return legacyPath;
      } catch {
        return null;
      }
    }
    return null;
  }

  getCudaVersionFilePath() {
    return path.join(this.getBinDir(), CUDA_VERSION_FILE);
  }

  getCudaBinaryVersion() {
    const versionPath = this.getCudaVersionFilePath();
    if (!fs.existsSync(versionPath)) return null;
    try {
      const version = fs.readFileSync(versionPath, "utf8").trim();
      return version || null;
    } catch {
      return null;
    }
  }

  getExpectedCudaBinaryVersion() {
    return BINARY_VERSION;
  }

  isCudaBinaryUpToDate() {
    return this.getCudaBinaryVersion() === BINARY_VERSION;
  }

  getCudaBinaryPath() {
    const binaryPath = this.getCudaBinaryFilePath();
    if (!binaryPath) return null;
    if (!this.isCudaBinaryUpToDate()) return null;
    return binaryPath;
  }

  hasCudaBinary() {
    return this.getCudaBinaryPath() !== null;
  }

  wasCudaPreviouslyInstalled() {
    return this.getCudaBinaryFilePath() !== null || this.getLegacyCudaBinaryPath() !== null;
  }

  async migrateLegacyCudaBinary() {
    const existingPath = this.getCudaBinaryFilePath();
    const legacyPath = this.getLegacyCudaBinaryPath();
    if (existingPath || !legacyPath) {
      return { migrated: false, binaryPath: existingPath || legacyPath || null };
    }

    const key = this.getPlatformKey();
    const spec = CUDA_BINARIES[key];
    if (!spec) {
      return { migrated: false, binaryPath: null };
    }

    const binDir = this.getBinDir();
    await fsp.mkdir(binDir, { recursive: true });

    const binaryPath = path.join(binDir, spec.outputName);
    const tempPath = `${binaryPath}.tmp`;
    try {
      // Copy (never move) — the legacy binary lives in the app's resources
      // directory, which must stay intact.
      await this.placeFileAtomic(legacyPath, binaryPath, { executable: true });
      debugLogger.info("GpuBinaryManager: migrated legacy binary, will be updated on next check", {
        legacyPath,
        binaryPath,
      });
      return { migrated: true, binaryPath };
    } catch (error) {
      await fsp.unlink(tempPath).catch(() => {});
      debugLogger.warn("GpuBinaryManager: failed to migrate legacy CUDA binary", {
        legacyPath,
        binaryPath,
        error: error.message,
      });
      throw error;
    }
  }

  async computeSha256(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      const stream = fs.createReadStream(filePath);
      stream.on("error", reject);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  }

  async extractArchive(archivePath, extractDir) {
    await fs.promises.mkdir(extractDir, { recursive: true });
    const extractRoot = path.resolve(extractDir);
    const directory = await unzipper.Open.file(archivePath);

    for (const entry of directory.files) {
      const entryPath = String(entry.path || "").replace(/\\/g, "/");
      const parts = entryPath.split("/").filter(Boolean);

      if (
        !entryPath ||
        path.isAbsolute(entryPath) ||
        parts.length === 0 ||
        parts.some((part) => part === "..")
      ) {
        throw new Error(`Unsafe path in CUDA package: ${entry.path}`);
      }

      const mode = (entry.externalFileAttributes || 0) >>> 16;
      const fileType = mode & 0o170000;
      if (entry.type === "SymbolicLink" || fileType === 0o120000) {
        throw new Error(`Symlink entries are not allowed in CUDA package: ${entry.path}`);
      }

      const destPath = path.resolve(extractRoot, ...parts);
      if (destPath !== extractRoot && !destPath.startsWith(`${extractRoot}${path.sep}`)) {
        throw new Error(`Unsafe path in CUDA package: ${entry.path}`);
      }

      if (entry.type === "Directory" || entryPath.endsWith("/")) {
        await fs.promises.mkdir(destPath, { recursive: true });
        continue;
      }

      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      await pipeline(entry.stream(), fs.createWriteStream(destPath, { flags: "wx" }));
    }
  }

  async findFileRecursive(rootDir, predicate) {
    const stack = [rootDir];
    while (stack.length > 0) {
      const current = stack.pop();
      const entries = await fsp.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(entryPath);
        } else if (predicate(entry.name, entryPath)) {
          return entryPath;
        }
      }
    }
    return null;
  }

  async findFilesRecursive(rootDir, predicate) {
    const matches = [];
    const stack = [rootDir];
    while (stack.length > 0) {
      const current = stack.pop();
      const entries = await fsp.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(entryPath);
        } else if (predicate(entry.name, entryPath)) {
          matches.push(entryPath);
        }
      }
    }
    return matches;
  }

  /**
   * Atomically place a file at destPath (write to `.tmp`, then rename).
   *
   * With `move: true` the source is renamed instead of copied — instant on the
   * same volume, which matters for the multi-hundred-MB CUDA runtime libraries.
   * Only use `move` for sources we own (e.g. the temp extraction dir); it falls
   * back to a copy across volumes (EXDEV).
   *
   * All I/O is async so large files never block the Electron main process.
   */
  async placeFileAtomic(sourcePath, destPath, { executable = false, move = false } = {}) {
    const tempPath = `${destPath}.tmp`;
    if (move) {
      try {
        await fsp.rename(sourcePath, tempPath);
      } catch (error) {
        if (error.code !== "EXDEV") throw error;
        await fsp.copyFile(sourcePath, tempPath);
      }
    } else {
      await fsp.copyFile(sourcePath, tempPath);
    }
    if (executable && process.platform !== "win32") {
      await fsp.chmod(tempPath, 0o755);
    }
    await fsp.rename(tempPath, destPath);
  }

  async installCudaPackage(archivePath, spec, binDir) {
    const extractDir = path.join(binDir, `cuda-package-${Date.now()}`);
    try {
      await this.extractArchive(archivePath, extractDir);

      const extractedBinary = await this.findFileRecursive(
        extractDir,
        (name) => name === spec.outputName || name === path.basename(spec.outputName)
      );
      if (!extractedBinary) {
        throw new Error(`CUDA package did not contain ${spec.outputName}`);
      }

      const binaryPath = path.join(binDir, spec.outputName);
      await this.placeFileAtomic(extractedBinary, binaryPath, { executable: true, move: true });

      const companionFiles = await this.findFilesRecursive(extractDir, (name) =>
        spec.companionPattern?.test(name)
      );
      const companionPaths = [];
      let companionBytes = 0;
      for (const companion of companionFiles) {
        const dest = path.join(binDir, path.basename(companion));
        await this.placeFileAtomic(companion, dest, {
          executable: process.platform !== "win32",
          move: true,
        });
        companionPaths.push(dest);
        try {
          companionBytes += (await fsp.stat(dest)).size;
        } catch {
          /* ignore */
        }
      }

      const binaryBytes = (await fsp.stat(binaryPath)).size;
      return {
        binaryPath,
        binaryBytes,
        companionCount: companionFiles.length,
        companionBytes,
        companionPaths,
        totalBytes: binaryBytes + companionBytes,
      };
    } finally {
      await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async writeCudaBinaryVersionFile() {
    const versionPath = this.getCudaVersionFilePath();
    const tempVersionPath = `${versionPath}.tmp`;
    await fsp.writeFile(tempVersionPath, BINARY_VERSION, "utf8");
    await fsp.rename(tempVersionPath, versionPath);
    return versionPath;
  }

  async downloadCudaBinary(onProgress) {
    const key = this.getPlatformKey();
    const spec = CUDA_BINARIES[key];
    if (!spec) {
      return { success: false, error: `CUDA binary not supported on platform: ${key}` };
    }

    const subscriber = typeof onProgress === "function" ? onProgress : null;
    if (subscriber) {
      this._progressSubscribers.add(subscriber);
      // A caller joining a download already in flight has missed every event so
      // far; replay the latest so its progress bar starts at the real
      // percentage instead of 0.
      if (this._downloading && this._lastProgress) {
        try {
          subscriber(this._lastProgress);
        } catch {
          /* ignore */
        }
      }
    }

    try {
      // Concurrent callers (startup auto-update, Settings, onboarding) all want
      // the same package, so a second request joins the running download and
      // gets its result. Returning "already in progress" as an error instead
      // made the Settings button look broken while the very download it asked
      // for was running invisibly in the background.
      if (!this._downloadPromise) {
        this._downloading = true;
        this._downloadPromise = this._runCudaDownload(spec).finally(() => {
          this._downloadPromise = null;
          this._downloading = false;
          // Drop the final progress frame so a later status poll cannot report
          // a stale 100% as if a download were still running.
          this._lastProgress = null;
        });
      }
      return await this._downloadPromise;
    } finally {
      if (subscriber) this._progressSubscribers.delete(subscriber);
    }
  }

  async _runCudaDownload(spec) {
    let archivePath = null;
    let binaryPath = null;

    try {
      this._abortController = createDownloadSignal();
      const { signal } = this._abortController;

      const binDir = this.getBinDir();
      fs.mkdirSync(binDir, { recursive: true });
      archivePath = path.join(binDir, spec.archiveName);
      const totalBytes = spec.approxBytes;

      debugLogger.info("GpuBinaryManager: downloading CUDA package from R2", {
        url: spec.remoteUrl,
        archiveName: spec.archiveName,
        outputName: spec.outputName,
      });

      await downloadFile(spec.remoteUrl, archivePath, {
        signal,
        timeout: 600000, // 10 min for large packages
        maxRetries: 2,
        onProgress: (bytesDownloaded, total) => {
          const effectiveTotal = total || totalBytes;
          const percent =
            effectiveTotal > 0 ? Math.round((bytesDownloaded / effectiveTotal) * 100) : 0;
          this._emitProgress({
            phase: "downloading",
            percent,
            bytesDownloaded,
            totalBytes: effectiveTotal,
          });
        },
      });

      if (signal.aborted) {
        throw Object.assign(new Error("Download cancelled"), { isAbort: true });
      }

      this._emitProgress({
        phase: "installing",
        percent: 99,
        bytesDownloaded: totalBytes,
        totalBytes,
      });

      const installed = await this.installCudaPackage(archivePath, spec, binDir);
      binaryPath = installed.binaryPath;

      const binarySize = installed.binaryBytes ?? (await fsp.stat(binaryPath)).size;
      const totalInstalledBytes = installed.totalBytes ?? binarySize;
      if (binarySize < MIN_CUDA_LAUNCHER_BYTES || totalInstalledBytes < MIN_CUDA_PACKAGE_BYTES) {
        for (const installedPath of [binaryPath, ...(installed.companionPaths || [])]) {
          try {
            if (installedPath && fs.existsSync(installedPath)) fs.unlinkSync(installedPath);
          } catch {
            /* ignore */
          }
        }
        debugLogger.error("GpuBinaryManager: extracted CUDA package is too small", {
          binaryPath,
          binarySize,
          companionCount: installed.companionCount,
          totalInstalledBytes,
        });
        return { success: false, error: "Extracted CUDA package is too small, likely corrupted" };
      }

      try {
        const sha256 = await this.computeSha256(binaryPath);
        debugLogger.info("GpuBinaryManager: CUDA binary SHA256", { binaryPath, sha256 });
        // TODO: Compare SHA256 against a signed manifest and fail download on mismatch.
      } catch (hashError) {
        debugLogger.warn("GpuBinaryManager: failed to compute CUDA binary SHA256", {
          binaryPath,
          error: hashError.message,
        });
      }

      const versionPath = await this.writeCudaBinaryVersionFile();

      this._emitProgress({ phase: "done", percent: 100, bytesDownloaded: totalBytes, totalBytes });

      try {
        if (archivePath && fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
      } catch {
        /* ignore */
      }

      debugLogger.info("GpuBinaryManager: CUDA package installed successfully", {
        binaryPath,
        companionCount: installed.companionCount,
        version: BINARY_VERSION,
        versionPath,
      });
      return { success: true, binaryPath };
    } catch (error) {
      // downloadFile writes to archivePath.tmp and only renames on success. Keep
      // any existing final binary/version file intact when an update fails.
      const shouldPreservePartialDownload = error.isAbort || isRetryable(error);
      if (!shouldPreservePartialDownload) {
        try {
          const tempPath = archivePath ? `${archivePath}.tmp` : null;
          if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
          if (archivePath && fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
        } catch {
          /* ignore */
        }
      }
      try {
        const tempVersionPath = `${this.getCudaVersionFilePath()}.tmp`;
        if (fs.existsSync(tempVersionPath)) fs.unlinkSync(tempVersionPath);
      } catch {
        /* ignore */
      }

      if (error.isAbort) {
        debugLogger.info("GpuBinaryManager: download cancelled");
        return { success: false, error: "Download cancelled" };
      }

      debugLogger.error("GpuBinaryManager: download failed", { error: error.message });
      return { success: false, error: error.message };
    } finally {
      this._abortController = null;
    }
  }

  cancelDownload() {
    if (this._abortController) {
      debugLogger.info("GpuBinaryManager: cancelling download");
      this._abortController.abort();
    }
  }
}

GpuBinaryManager.CUDA_BINARIES = CUDA_BINARIES;

module.exports = GpuBinaryManager;
