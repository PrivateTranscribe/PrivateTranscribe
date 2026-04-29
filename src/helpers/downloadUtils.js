const fs = require("fs");
const { promises: fsPromises } = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { pipeline } = require("stream");
const debugLogger = require("./debugLogger");

const USER_AGENT = "PrivateTranscribe/1.0";
const PROGRESS_THROTTLE_MS = 100;
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT = 60000;
const DEFAULT_MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 30000;
// Temp files older than this are considered abandoned and eligible for deletion.
const STALE_TMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

function isRetryable(error) {
  if (error.isAbort || error.isHttpError) return false;
  return RETRYABLE_CODES.has(error.code);
}

function backoffDelay(attempt) {
  return Math.min(1000 * Math.pow(2, attempt), MAX_BACKOFF_MS);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveRedirects(url, timeout) {
  return new Promise((resolve, reject) => {
    let redirectCount = 0;

    const follow = (currentUrl) => {
      if (redirectCount > MAX_REDIRECTS) {
        reject(Object.assign(new Error("Too many redirects"), { isHttpError: true }));
        return;
      }

      const client = currentUrl.startsWith("https") ? https : http;
      const parsed = new URL(currentUrl);
      const req = client.request({
        method: "HEAD",
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        timeout,
        headers: { "User-Agent": USER_AGENT },
      });

      req.on("response", (res) => {
        res.resume();
        if (
          res.statusCode === 301 ||
          res.statusCode === 302 ||
          res.statusCode === 303 ||
          res.statusCode === 307 ||
          res.statusCode === 308
        ) {
          const location = res.headers.location;
          if (!location) {
            reject(
              Object.assign(new Error("Redirect without location header"), { isHttpError: true })
            );
            return;
          }
          redirectCount++;
          follow(new URL(location, currentUrl).toString());
          return;
        }
        resolve({ finalUrl: currentUrl, statusCode: res.statusCode });
      });

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(Object.assign(new Error("Timeout resolving redirects"), { code: "ETIMEDOUT" }));
      });

      req.end();
    };

    follow(url);
  });
}

function downloadAttempt(url, tempPath, { timeout, onProgress, signal, startOffset }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("Download cancelled"), { isAbort: true }));
      return;
    }

    const headers = { "User-Agent": USER_AGENT };
    if (startOffset > 0) {
      headers["Range"] = `bytes=${startOffset}-`;
    }

    const client = url.startsWith("https") ? https : http;
    let activeFile = fs.createWriteStream(tempPath, { flags: startOffset > 0 ? "a" : "w" });

    let downloadedSize = startOffset;
    let totalSize = 0;
    let lastProgressUpdate = 0;
    let request = null;

    const cleanup = () => {
      if (request) {
        request.destroy();
        request = null;
      }
      activeFile.destroy();
    };

    const onAbort = () => {
      cleanup();
      reject(Object.assign(new Error("Download cancelled"), { isAbort: true }));
    };

    if (signal) {
      signal.onAbort = onAbort;
    }

    request = client.get(url, { headers, timeout }, (response) => {
      if (signal?.aborted) {
        cleanup();
        reject(Object.assign(new Error("Download cancelled"), { isAbort: true }));
        return;
      }

      const statusCode = response.statusCode;

      if (statusCode === 200 && startOffset > 0) {
        // Server doesn't support Range - restart from beginning
        downloadedSize = 0;
        activeFile.destroy();
        activeFile = fs.createWriteStream(tempPath, { flags: "w" });
        totalSize = parseInt(response.headers["content-length"], 10) || 0;
      } else if (statusCode === 206) {
        const contentRange = response.headers["content-range"];
        if (contentRange) {
          const match = contentRange.match(/\/(\d+)$/);
          if (match) totalSize = parseInt(match[1], 10);
        }
        if (!totalSize) {
          const contentLength = parseInt(response.headers["content-length"], 10) || 0;
          totalSize = startOffset + contentLength;
        }
      } else if (statusCode === 200) {
        totalSize = parseInt(response.headers["content-length"], 10) || 0;
      } else {
        cleanup();
        const err = new Error(`HTTP ${statusCode}`);
        err.isHttpError = true;
        err.statusCode = statusCode;
        reject(err);
        return;
      }

      response.on("data", (chunk) => {
        if (signal?.aborted) {
          cleanup();
          return;
        }
        downloadedSize += chunk.length;
        emitProgress();
      });

      pipeline(response, activeFile, (err) => {
        if (signal) signal.onAbort = null;
        if (err) {
          if (signal?.aborted) {
            reject(Object.assign(new Error("Download cancelled"), { isAbort: true }));
          } else {
            reject(err);
          }
        } else {
          resolve({ downloadedSize, totalSize });
        }
      });
    });

    request.on("error", (err) => {
      if (signal) signal.onAbort = null;
      cleanup();
      if (signal?.aborted) {
        reject(Object.assign(new Error("Download cancelled"), { isAbort: true }));
      } else {
        reject(err);
      }
    });

    request.on("timeout", () => {
      if (signal) signal.onAbort = null;
      cleanup();
      reject(Object.assign(new Error("Socket timeout"), { code: "ETIMEDOUT" }));
    });

    function emitProgress() {
      if (!onProgress || totalSize <= 0) return;
      const now = Date.now();
      if (now - lastProgressUpdate >= PROGRESS_THROTTLE_MS || downloadedSize >= totalSize) {
        lastProgressUpdate = now;
        onProgress(downloadedSize, totalSize);
      }
    }
  });
}

/**
 * Delete `.tmp` files in `dir` that have not been modified for longer than
 * STALE_TMP_MAX_AGE_MS.  Silently skips any entry it cannot stat or remove.
 */
async function cleanStaleTmpFiles(dir) {
  let entries;
  try {
    entries = await fsPromises.readdir(dir);
  } catch {
    return; // Directory doesn't exist yet — nothing to clean.
  }

  const now = Date.now();
  await Promise.all(
    entries
      .filter((name) => name.endsWith(".tmp"))
      .map(async (name) => {
        const filePath = path.join(dir, name);
        try {
          const stat = await fsPromises.stat(filePath);
          if (now - stat.mtimeMs > STALE_TMP_MAX_AGE_MS) {
            await fsPromises.unlink(filePath);
            debugLogger.info("Deleted stale temp file", { filePath });
          }
        } catch {
          // Ignore — file may have been removed by a concurrent process.
        }
      })
  );
}

async function downloadFile(url, destPath, options = {}) {
  const {
    onProgress,
    timeout = DEFAULT_TIMEOUT,
    maxRetries = DEFAULT_MAX_RETRIES,
    signal,
  } = options;

  const tempPath = `${destPath}.tmp`;

  // Sweep the destination directory for abandoned temp files before starting.
  await cleanStaleTmpFiles(path.dirname(destPath));

  debugLogger.info("Download starting", { url: url.substring(0, 80), destPath });

  let startOffset = 0;
  try {
    const stats = await fsPromises.stat(tempPath);
    if (stats.size > 0) {
      startOffset = stats.size;
      debugLogger.info("Resuming download", { startOffset });
    }
  } catch {
    // No existing temp file
  }

  const { finalUrl } = await resolveRedirects(url, timeout);

  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw Object.assign(new Error("Download cancelled"), { isAbort: true });
    }

    if (attempt > 0) {
      const delay = backoffDelay(attempt - 1);
      debugLogger.info("Retrying download", { attempt, delay, startOffset });
      await sleep(delay);

      // Update startOffset from temp file in case partial data was written
      try {
        const stats = await fsPromises.stat(tempPath);
        if (stats.size > 0) startOffset = stats.size;
      } catch {
        startOffset = 0;
      }
    }

    try {
      await downloadAttempt(finalUrl, tempPath, { timeout, onProgress, signal, startOffset });

      // Atomic move to final path
      try {
        await fsPromises.rename(tempPath, destPath);
      } catch (renameError) {
        if (renameError.code === "EXDEV") {
          await fsPromises.copyFile(tempPath, destPath);
          await fsPromises.unlink(tempPath).catch(() => {});
        } else {
          throw renameError;
        }
      }

      debugLogger.info("Download complete", { destPath });
      return destPath;
    } catch (error) {
      lastError = error;

      if (error.isAbort) {
        // Preserve partial .tmp so the next attempt can resume from this offset
        debugLogger.info("Download cancelled — partial file preserved for resume", { tempPath });
        throw error;
      }

      if (!isRetryable(error)) {
        await fsPromises.unlink(tempPath).catch(() => {});
        throw error;
      }

      if (attempt >= maxRetries) {
        // Keep partial network downloads so the next user-initiated attempt can resume.
        debugLogger.warn("Download retries exhausted - partial file preserved for resume", {
          tempPath,
          error: error.message,
          code: error.code,
        });
        throw error;
      }

      debugLogger.warn("Download attempt failed", {
        attempt: attempt + 1,
        error: error.message,
        code: error.code,
      });
    }
  }

  await fsPromises.unlink(tempPath).catch(() => {});
  throw lastError;
}

function createDownloadSignal() {
  const signal = { aborted: false, onAbort: null };
  return {
    signal,
    abort() {
      signal.aborted = true;
      if (typeof signal.onAbort === "function") {
        signal.onAbort();
      }
    },
  };
}

module.exports = { downloadFile, createDownloadSignal, cleanStaleTmpFiles, isRetryable };
