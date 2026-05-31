"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const unzipper = require("unzipper");
const { pipeline } = require("stream/promises");
const { app } = require("electron");
const debugLogger = require("./debugLogger");
const { downloadFile, createDownloadSignal, isRetryable } = require("./downloadUtils");

// R2 public CDN — binaries served directly (no zip extraction needed)
const R2_BASE_URL = "https://updates.privatetranscribe.com";
const BINARY_VERSION = "v0.0.8";
const USER_AGENT = "PrivateTranscribe/1.0";
const CUDA_VERSION_FILE = "whisper-server-cuda-version.txt";
const MIN_CUDA_LAUNCHER_BYTES = 100_000;
const MIN_CUDA_PACKAGE_BYTES = 10_000_000;

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

  migrateLegacyCudaBinary() {
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
    fs.mkdirSync(binDir, { recursive: true });

    const binaryPath = path.join(binDir, spec.outputName);
    const tempPath = `${binaryPath}.tmp`;
    try {
      fs.copyFileSync(legacyPath, tempPath);
      if (process.platform !== "win32") {
        fs.chmodSync(tempPath, 0o755);
      }
      fs.renameSync(tempPath, binaryPath);
      debugLogger.info("GpuBinaryManager: migrated legacy binary, will be updated on next check", {
        legacyPath,
        binaryPath,
      });
      return { migrated: true, binaryPath };
    } catch (error) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        /* ignore */
      }
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

  findFileRecursive(rootDir, predicate) {
    const stack = [rootDir];
    while (stack.length > 0) {
      const current = stack.pop();
      const entries = fs.readdirSync(current, { withFileTypes: true });
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

  findFilesRecursive(rootDir, predicate) {
    const matches = [];
    const stack = [rootDir];
    while (stack.length > 0) {
      const current = stack.pop();
      const entries = fs.readdirSync(current, { withFileTypes: true });
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

  copyFileAtomic(sourcePath, destPath, { executable = false } = {}) {
    const tempPath = `${destPath}.tmp`;
    fs.copyFileSync(sourcePath, tempPath);
    if (executable && process.platform !== "win32") {
      fs.chmodSync(tempPath, 0o755);
    }
    fs.renameSync(tempPath, destPath);
  }

  async installCudaPackage(archivePath, spec, binDir) {
    const extractDir = path.join(binDir, `cuda-package-${Date.now()}`);
    try {
      await this.extractArchive(archivePath, extractDir);

      const extractedBinary = this.findFileRecursive(
        extractDir,
        (name) => name === spec.outputName || name === path.basename(spec.outputName)
      );
      if (!extractedBinary) {
        throw new Error(`CUDA package did not contain ${spec.outputName}`);
      }

      const binaryPath = path.join(binDir, spec.outputName);
      this.copyFileAtomic(extractedBinary, binaryPath, { executable: true });

      const companionFiles = this.findFilesRecursive(extractDir, (name) =>
        spec.companionPattern?.test(name)
      );
      const companionPaths = [];
      let companionBytes = 0;
      for (const companion of companionFiles) {
        const dest = path.join(binDir, path.basename(companion));
        this.copyFileAtomic(companion, dest, { executable: process.platform !== "win32" });
        companionPaths.push(dest);
        try {
          companionBytes += fs.statSync(dest).size;
        } catch {
          /* ignore */
        }
      }

      const binaryBytes = fs.statSync(binaryPath).size;
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

  writeCudaBinaryVersionFile() {
    const versionPath = this.getCudaVersionFilePath();
    const tempVersionPath = `${versionPath}.tmp`;
    fs.writeFileSync(tempVersionPath, BINARY_VERSION, "utf8");
    fs.renameSync(tempVersionPath, versionPath);
    return versionPath;
  }

  async downloadCudaBinary(onProgress) {
    const key = this.getPlatformKey();
    const spec = CUDA_BINARIES[key];
    if (!spec) {
      return { success: false, error: `CUDA binary not supported on platform: ${key}` };
    }

    // Prevent concurrent downloads (e.g. auto-update + manual Settings click)
    if (this._downloading) {
      return { success: false, error: "CUDA binary download already in progress" };
    }
    this._downloading = true;
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
          if (!onProgress) return;
          const effectiveTotal = total || totalBytes;
          const percent =
            effectiveTotal > 0 ? Math.round((bytesDownloaded / effectiveTotal) * 100) : 0;
          onProgress({
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

      if (onProgress) {
        onProgress({ phase: "installing", percent: 99, bytesDownloaded: totalBytes, totalBytes });
      }

      const installed = await this.installCudaPackage(archivePath, spec, binDir);
      binaryPath = installed.binaryPath;

      const binarySize = installed.binaryBytes ?? fs.statSync(binaryPath).size;
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

      const versionPath = this.writeCudaBinaryVersionFile();

      if (onProgress) {
        onProgress({ phase: "done", percent: 100, bytesDownloaded: totalBytes, totalBytes });
      }

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
      this._downloading = false;
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
