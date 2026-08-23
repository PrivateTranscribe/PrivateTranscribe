/**
 * SelectionCapture - reads whatever text the user has selected in another app.
 *
 * Windows gives no way to ask the foreground window for its selection, so the
 * only universal route is the one the user would take: press Ctrl+C and read
 * the clipboard. Three things make that harder than it sounds, and each one is
 * a deliberate piece of this file:
 *
 *   1. The trigger hotkey is still physically held when the read fires. A
 *      Ctrl+C injected while Ctrl+Shift+Alt are down arrives as
 *      Ctrl+Shift+Alt+C, which copies nothing at all - silently. The worker
 *      waits for every modifier to come up before it injects.
 *   2. The injection has to come from a process that is not Electron. Sending
 *      keystrokes from the main process reaches our own window, not the one
 *      the user was reading. A PowerShell child using SendKeys posts to the
 *      real foreground window.
 *   3. PowerShell costs ~300ms to start, which is the whole latency budget for
 *      a hotkey. So the worker is spawned once and kept alive on a line
 *      protocol rather than spawned per capture.
 *
 * The clipboard is saved before and restored after, always - a read must not
 * cost the user whatever they had copied.
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { clipboard } = require("electron");
const debugLogger = require("./debugLogger");

/** How long a single "copy" command may take before we give up on it. */
const COMMAND_TIMEOUT_MS = 4000;
/** Clipboard poll after the keystroke: the owning app updates asynchronously. */
const CLIPBOARD_POLL_ATTEMPTS = 30;
const CLIPBOARD_POLL_INTERVAL_MS = 30;

const WORKER_FILENAME = "readaloud-copy-worker.ps1";

class SelectionCapture {
  constructor() {
    this.isSupported = process.platform === "win32";
    this.worker = null;
    this.workerReady = false;
    this.pending = [];
    this.isStopping = false;
  }

  /**
   * Find the worker script from a source checkout and from a packaged app.
   * Mirrors WindowsKeyManager.resolveListenerBinary - same candidate shape, so
   * the two stay in step if the packaging layout ever changes.
   */
  resolveWorkerScript() {
    const candidates = new Set([path.join(__dirname, "..", "..", "resources", WORKER_FILENAME)]);

    if (process.resourcesPath) {
      [
        path.join(process.resourcesPath, WORKER_FILENAME),
        path.join(process.resourcesPath, "resources", WORKER_FILENAME),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", WORKER_FILENAME),
      ].forEach((candidate) => candidates.add(candidate));
    }

    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        continue;
      }
    }

    return null;
  }

  /**
   * Spawn the persistent copy worker. Safe to call repeatedly; a live worker is
   * reused. Returns true when a worker process exists (READY may still be in
   * flight - captureSelection waits for it).
   */
  start() {
    if (!this.isSupported) return false;
    if (this.worker) return true;

    const scriptPath = this.resolveWorkerScript();
    if (!scriptPath) {
      debugLogger.warn("[SelectionCapture] Copy worker script not found");
      return false;
    }

    this.isStopping = false;

    let child;
    try {
      child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
      );
    } catch (error) {
      debugLogger.error("[SelectionCapture] Failed to spawn copy worker", {
        error: error.message,
      });
      return false;
    }

    this.worker = child;
    this.workerReady = false;

    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        if (line === "READY") {
          this.workerReady = true;
          debugLogger.debug("[SelectionCapture] Copy worker ready");
          continue;
        }
        debugLogger.debug("[SelectionCapture] Worker line", { line });
        const resolve = this.pending.shift();
        if (resolve) resolve(line);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data) => {
      const message = String(data).trim();
      if (message) {
        debugLogger.warn("[SelectionCapture] Worker stderr", { message: message.slice(0, 300) });
      }
    });

    child.on("error", (error) => {
      if (this.worker !== child) return;
      debugLogger.error("[SelectionCapture] Copy worker error", { error: error.message });
    });

    child.on("exit", (code, signal) => {
      if (this.worker !== child) return;
      if (!this.isStopping) {
        debugLogger.warn("[SelectionCapture] Copy worker exited", { code, signal });
      }
      this.worker = null;
      this.workerReady = false;
      // Anything still waiting will never be answered. Fail it explicitly
      // rather than letting the caller sit on its timeout.
      while (this.pending.length) this.pending.shift()("ERR worker gone");
    });

    return true;
  }

  /** Stop the worker. Called on app quit alongside the other managers. */
  stop() {
    this.isStopping = true;
    if (this.worker) {
      try {
        this.worker.stdin.end();
      } catch {
        // Already closed.
      }
      try {
        this.worker.kill();
      } catch {
        // Already gone.
      }
      this.worker = null;
    }
    this.workerReady = false;
    while (this.pending.length) this.pending.shift()("ERR worker stopped");
  }

  /** Wait up to `timeoutMs` for the worker's READY line. */
  async waitForReady(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (!this.workerReady && this.worker && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.workerReady;
  }

  /**
   * Ask the worker to send one Ctrl+C. Resolves with the worker's reply line
   * ("OK waited=NNNms" or "ERR ..."), never rejects.
   */
  sendCopyKeystroke() {
    if (!this.worker || !this.workerReady) {
      return Promise.resolve("ERR worker not ready");
    }
    return new Promise((resolve) => {
      let settled = false;
      const once = (line) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(line);
      };
      this.pending.push(once);
      const timer = setTimeout(() => {
        const index = this.pending.indexOf(once);
        if (index >= 0) this.pending.splice(index, 1);
        once("ERR timeout");
      }, COMMAND_TIMEOUT_MS);

      try {
        this.worker.stdin.write("copy\n");
      } catch (error) {
        const index = this.pending.indexOf(once);
        if (index >= 0) this.pending.splice(index, 1);
        once(`ERR ${error.message}`);
      }
    });
  }

  /**
   * Capture the foreground app's current selection.
   *
   * @returns {Promise<{text: string, source: "selection"|"clipboard"|"none"|"unsupported",
   *                    waitedMs: number|null, detail: string}>}
   *   `source` says where the text came from: an actual copy, the clipboard we
   *   were about to overwrite, or nothing. `waitedMs` is how long the worker
   *   spent waiting for the trigger modifiers to be released, and is null when
   *   the worker reported an error.
   */
  async captureSelection() {
    if (!this.isSupported) {
      return { text: "", source: "unsupported", waitedMs: null, detail: "non-windows platform" };
    }

    if (!this.worker) this.start();
    await this.waitForReady();

    const previous = clipboard.readText();
    // Sentinel so we can tell "copy produced nothing" from "copy produced the
    // same text that was already on the clipboard".
    const sentinel = `__pt_sentinel_${Date.now()}__`;

    let detail = "ERR not attempted";
    let grabbed = "";
    try {
      clipboard.writeText(sentinel);

      detail = await this.sendCopyKeystroke();

      // The clipboard owner updates asynchronously. Poll instead of guessing.
      for (let attempt = 0; attempt < CLIPBOARD_POLL_ATTEMPTS; attempt++) {
        const now = clipboard.readText();
        if (now && now !== sentinel) {
          grabbed = now;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, CLIPBOARD_POLL_INTERVAL_MS));
      }
    } finally {
      // The user's clipboard is not ours to lose, including when the copy threw.
      clipboard.writeText(previous);
    }

    const waitedMs = parseWaitedMs(detail);

    if (grabbed && grabbed.trim()) {
      return { text: grabbed, source: "selection", waitedMs, detail };
    }
    // The copy produced nothing. Some apps refuse Ctrl+C, and some windows are
    // not the foreground window by the time we inject. Rather than doing
    // nothing, fall back to whatever was already on the clipboard and say so.
    if (previous && previous.trim()) {
      return { text: previous, source: "clipboard", waitedMs, detail };
    }
    return { text: "", source: "none", waitedMs, detail };
  }
}

/** "OK waited=120ms" -> 120. Anything else (including "ERR ...") -> null. */
function parseWaitedMs(line) {
  const match = /^OK waited=(\d+)ms$/.exec(String(line || "").trim());
  return match ? Number(match[1]) : null;
}

module.exports = SelectionCapture;
module.exports.parseWaitedMs = parseWaitedMs;
