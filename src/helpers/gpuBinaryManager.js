"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const { downloadFile, createDownloadSignal } = require("./downloadUtils");

// R2 public CDN — binaries served directly (no zip extraction needed)
const R2_BASE_URL = "https://updates.privatetranscribe.com";
const BINARY_VERSION = "v0.0.6";
const USER_AGENT = "PrivateTranscribe/1.0";
const CUDA_VERSION_FILE = "whisper-server-cuda-version.txt";

const CUDA_BINARIES = {
  "linux-x64": {
    outputName: "whisper-server-linux-x64-cuda",
    remoteUrl: `${R2_BASE_URL}/binaries/${BINARY_VERSION}/whisper-server-linux-x64-cuda`,
    approxBytes: 265000000, // ~253MB
  },
  "win32-x64": {
    outputName: "whisper-server-win32-x64-cuda.exe",
    remoteUrl: `${R2_BASE_URL}/binaries/${BINARY_VERSION}/whisper-server-win32-x64-cuda.exe`,
    approxBytes: 683000000, // ~652MB
  },
};

class GpuBinaryManager {
  constructor() {
    this._abortController = null;
  }

  getBinDir() {
    if (process.resourcesPath) {
      return path.join(process.resourcesPath, "bin");
    }
    return path.join(__dirname, "..", "..", "resources", "bin");
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

  async computeSha256(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      const stream = fs.createReadStream(filePath);
      stream.on("error", reject);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
    });
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

    this._abortController = createDownloadSignal();
    const { signal } = this._abortController;

    const binDir = this.getBinDir();
    fs.mkdirSync(binDir, { recursive: true });
    const binaryPath = path.join(binDir, spec.outputName);
    const totalBytes = spec.approxBytes;

    debugLogger.info("GpuBinaryManager: downloading CUDA binary from R2", {
      url: spec.remoteUrl,
      outputName: spec.outputName,
    });

    try {
      await downloadFile(spec.remoteUrl, binaryPath, {
        signal,
        timeout: 600000, // 10 min for large files
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
        try {
          fs.unlinkSync(binaryPath);
        } catch {
          /* ignore */
        }
        throw Object.assign(new Error("Download cancelled"), { isAbort: true });
      }

      // Set executable bit on non-Windows
      if (process.platform !== "win32") {
        fs.chmodSync(binaryPath, 0o755);
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

      debugLogger.info("GpuBinaryManager: CUDA binary downloaded successfully", {
        binaryPath,
        version: BINARY_VERSION,
        versionPath,
      });
      return { success: true, binaryPath };
    } catch (error) {
      // Clean up partial file on failure
      try {
        if (fs.existsSync(binaryPath)) fs.unlinkSync(binaryPath);
      } catch {
        /* ignore */
      }
      try {
        const versionPath = this.getCudaVersionFilePath();
        if (fs.existsSync(versionPath)) fs.unlinkSync(versionPath);
      } catch {
        /* ignore */
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
