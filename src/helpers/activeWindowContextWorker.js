"use strict";

// Worker-thread entry for active-window context capture.
//
// getActiveWindowContext() uses spawnSync (PowerShell/UIA on Windows, osascript
// on macOS, xdotool on Linux) which can block for hundreds of milliseconds. We
// run it here, off the Electron main process, so the UI/IPC/hotkey event loop is
// never stalled. See activeWindowContextRunner.js for the host side.

const { parentPort } = require("worker_threads");

if (!parentPort) {
  // Not actually running as a worker — nothing to do.
  return;
}

try {
  const { getActiveWindowContext } = require("./activeWindowContext");
  const result = getActiveWindowContext();
  parentPort.postMessage({ ok: true, result });
} catch (err) {
  parentPort.postMessage({ ok: false, error: (err && err.message) || String(err) });
}
