"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const unzipper = require("unzipper");
const debugLogger = require("./debugLogger");
const { downloadFile, createDownloadSignal } = require("./downloadUtils");

const GITHUB_API_URL =
  "https://api.github.com/repos/OpenWhispr/whisper.cpp/releases/latest";
const USER_AGENT = "PrivateTranscribe/1.0";

const CUDA_BINARIES = {
  "linux-x64": {
    zipName: "whisper-server-linux-x64-cuda.zip",
    binaryName: "whisper-server-linux-x64-cuda",
    outputName: "whisper-server-linux-x64-cuda",
  },
  "win32-x64": {
    zipName: "whisper-server-win32-x64-cuda.zip",
    binaryName: "whisper-server-win32-x64-cuda.exe",
    outputName: "whisper-server-win32-x64-cuda.exe",
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

  getCudaBinaryPath() {
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

  hasCudaBinary() {
    return this.getCudaBinaryPath() !== null;
  }

  async downloadCudaBinary(onProgress) {
    const key = this.getPlatformKey();
    const spec = CUDA_BINARIES[key];
    if (!spec) {
      return { success: false, error: `CUDA binary not supported on platform: ${key}` };
    }

    this._abortController = createDownloadSignal();
    const { signal, abort } = this._abortController;

    const binDir = this.getBinDir();
    const zipPath = path.join(binDir, spec.zipName);
    const binaryPath = path.join(binDir, spec.outputName);

    try {
      // Fetch latest release metadata
      debugLogger.info("GpuBinaryManager: fetching latest release info", { url: GITHUB_API_URL });
      const release = await this._fetchJson(GITHUB_API_URL, signal);

      const asset = (release.assets || []).find((a) => a.name === spec.zipName);
      if (!asset) {
        return {
          success: false,
          error: `Asset ${spec.zipName} not found in latest release`,
        };
      }

      const downloadUrl = asset.browser_download_url;
      const totalBytes = asset.size || 0;

      debugLogger.info("GpuBinaryManager: downloading CUDA binary zip", {
        url: downloadUrl.substring(0, 80),
        size: totalBytes,
      });

      // Download zip with progress tracking
      let lastPercent = 0;
      await downloadFile(downloadUrl, zipPath, {
        signal,
        timeout: 300000, // 5 min for large files
        maxRetries: 2,
        onProgress: (bytesDownloaded, total) => {
          if (!onProgress) return;
          const effectiveTotal = total || totalBytes;
          const percent =
            effectiveTotal > 0 ? Math.round((bytesDownloaded / effectiveTotal) * 80) : lastPercent;
          lastPercent = percent;
          onProgress({
            phase: "downloading",
            percent,
            bytesDownloaded,
            totalBytes: effectiveTotal,
          });
        },
      });

      if (signal.aborted) {
        fs.unlink(zipPath, () => {});
        throw Object.assign(new Error("Download cancelled"), { isAbort: true });
      }

      // Extract binary from zip
      debugLogger.info("GpuBinaryManager: extracting zip", { zipPath, binaryName: spec.binaryName });
      if (onProgress) {
        onProgress({ phase: "extracting", percent: 85, bytesDownloaded: totalBytes, totalBytes });
      }

      await this._extractBinaryFromZip(zipPath, spec.binaryName, binaryPath);

      // Set executable bit on non-Windows
      if (process.platform !== "win32") {
        fs.chmodSync(binaryPath, 0o755);
      }

      // Clean up zip
      try {
        fs.unlinkSync(zipPath);
      } catch (cleanupErr) {
        debugLogger.warn("GpuBinaryManager: failed to clean up zip", { error: cleanupErr.message });
      }

      if (onProgress) {
        onProgress({ phase: "done", percent: 100, bytesDownloaded: totalBytes, totalBytes });
      }

      debugLogger.info("GpuBinaryManager: CUDA binary downloaded successfully", { binaryPath });
      return { success: true, binaryPath };
    } catch (error) {
      // Clean up partial zip on failure
      try {
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
      } catch {
        // ignore cleanup errors
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

  _fetchJson(url, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(Object.assign(new Error("Download cancelled"), { isAbort: true }));
        return;
      }

      const req = https.get(
        url,
        {
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/vnd.github+json",
          },
          timeout: 15000,
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            reject(
              Object.assign(new Error(`GitHub API returned HTTP ${res.statusCode}`), {
                isHttpError: true,
              })
            );
            return;
          }

          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch (parseErr) {
              reject(new Error(`Failed to parse GitHub API response: ${parseErr.message}`));
            }
          });
        }
      );

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(Object.assign(new Error("GitHub API request timed out"), { code: "ETIMEDOUT" }));
      });

      if (signal) {
        const onAbort = () => {
          req.destroy();
          reject(Object.assign(new Error("Download cancelled"), { isAbort: true }));
        };
        if (signal.aborted) {
          onAbort();
        } else {
          // Attach abort listener in the downloadUtils signal style
          const origOnAbort = signal.onAbort;
          signal.onAbort = () => {
            onAbort();
            if (typeof origOnAbort === "function") origOnAbort();
          };
        }
      }
    });
  }

  _extractBinaryFromZip(zipPath, binaryName, destPath) {
    return new Promise((resolve, reject) => {
      fs.createReadStream(zipPath)
        .pipe(unzipper.Parse())
        .on("entry", (entry) => {
          const fileName = path.basename(entry.path);
          if (fileName === binaryName) {
            entry
              .pipe(fs.createWriteStream(destPath))
              .on("finish", resolve)
              .on("error", reject);
          } else {
            entry.autodrain();
          }
        })
        .on("error", reject)
        .on("finish", () => {
          // If destPath wasn't created, the binary wasn't in the zip
          if (!fs.existsSync(destPath)) {
            reject(new Error(`Binary ${binaryName} not found in zip archive`));
          }
        });
    });
  }
}

GpuBinaryManager.CUDA_BINARIES = CUDA_BINARIES;

module.exports = GpuBinaryManager;
