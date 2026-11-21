/**
 * Reloads a window whose page process died. Without it the dictation overlay
 * stayed blank after a renderer crash, and the hotkey did nothing until the
 * app was restarted.
 *
 * A page that crashes again right after each reload would loop forever, so
 * reloads stop after `maxReloads` inside `windowMs`. A clean exit is Electron
 * closing the page on purpose and is left alone.
 */
const debugLogger = require("./debugLogger");

const DEFAULT_MAX_RELOADS = 3;
const DEFAULT_WINDOW_MS = 60_000;

function attachRendererCrashRecovery(
  win,
  {
    label,
    reload,
    maxReloads = DEFAULT_MAX_RELOADS,
    windowMs = DEFAULT_WINDOW_MS,
    now = () => Date.now(),
    logger = debugLogger,
  }
) {
  const recentReloads = [];

  const onGone = (_event, details = {}) => {
    const reason = details.reason || "unknown";
    if (reason === "clean-exit") return;
    if (!win || win.isDestroyed()) return;

    const at = now();
    while (recentReloads.length > 0 && at - recentReloads[0] > windowMs) {
      recentReloads.shift();
    }
    if (recentReloads.length >= maxReloads) {
      logger.error(`${label} page crashed again; not reloading`, {
        reason,
        exitCode: details.exitCode,
        reloadsInWindow: recentReloads.length,
      });
      return;
    }
    recentReloads.push(at);

    logger.error(`${label} page crashed; reloading it`, {
      reason,
      exitCode: details.exitCode,
      attempt: recentReloads.length,
    });
    Promise.resolve()
      .then(() => reload())
      .catch((error) => {
        logger.error(`${label} reload after a crash failed`, { error: error?.message });
      });
  };

  win.webContents.on("render-process-gone", onGone);
  return () => win.webContents.removeListener?.("render-process-gone", onGone);
}

module.exports = { attachRendererCrashRecovery };
