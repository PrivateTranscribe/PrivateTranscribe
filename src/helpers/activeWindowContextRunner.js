"use strict";

const path = require("path");
const { Worker } = require("worker_threads");

const WORKER_PATH = path.join(__dirname, "activeWindowContextWorker.js");

// Slightly longer than the capture's internal spawnSync budget (2500ms) so a
// slow-but-successful capture still returns instead of being killed early.
const WORKER_TIMEOUT_MS = 3000;

/**
 * Run active-window context capture on a worker thread so its spawnSync calls
 * (PowerShell/UIA on Windows, osascript on macOS, xdotool on Linux) never block
 * the Electron main process event loop.
 *
 * Always resolves (never rejects) — on timeout, worker error, or failure it
 * returns a safe "unavailable" payload matching getActiveWindowContext()'s shape.
 *
 * @returns {Promise<object>}
 */
function captureActiveWindowContext() {
  return new Promise((resolve) => {
    let settled = false;
    let worker = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (worker) {
        worker.terminate().catch(() => {});
      }
      resolve(value);
    };

    const timer = setTimeout(() => {
      finish({ available: false, reason: "context capture timed out" });
    }, WORKER_TIMEOUT_MS);
    // Don't let this timer keep the process alive on its own.
    if (typeof timer.unref === "function") timer.unref();

    try {
      worker = new Worker(WORKER_PATH);
    } catch {
      finish({ available: false, reason: "context capture worker unavailable" });
      return;
    }

    worker.once("message", (msg) => {
      if (msg && msg.ok) {
        finish(msg.result);
      } else {
        finish({ available: false, reason: (msg && msg.error) || "context capture failed" });
      }
    });

    worker.once("error", () => {
      finish({ available: false, reason: "context capture error" });
    });

    // If the worker exits before posting a message, still resolve.
    worker.once("exit", () => {
      finish({ available: false, reason: "context capture exited" });
    });
  });
}

module.exports = { captureActiveWindowContext };
