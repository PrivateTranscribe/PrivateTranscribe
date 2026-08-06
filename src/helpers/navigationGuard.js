/**
 * Hand a URL to the OS default browser / mail client.
 * Resolved lazily so this module can be loaded without a live Electron runtime.
 */
function defaultOpenExternal(url) {
  const { shell } = require("electron");
  return shell.openExternal(url);
}

/**
 * Allowlist of URL protocols that may be handed to shell.openExternal().
 * - https / http  : web links
 * - mailto        : email client links (e.g. support@privatetranscribe.com)
 *
 * Explicitly excluded: file://, javascript:, data:, and any unknown protocol
 * that could be exploited on the host desktop environment.
 */
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);

function isAllowedExternalUrl(url) {
  try {
    const parsed = new URL(url);
    return ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * True when `url` is app content we ship ourselves.
 *
 * Production loads the renderer from disk (file:), development loads it from the
 * Vite dev server. Nothing else is app content, so nothing else may be navigated
 * to inside a window that has the preload bridge attached.
 *
 * @param {string} url
 * @param {string|null} [devServerUrl] - dev server origin, only set in development
 */
function isInternalUrl(url, devServerUrl = null) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol === "file:") return true;

  if (devServerUrl) {
    try {
      if (parsed.origin === new URL(devServerUrl).origin) return true;
    } catch {
      // Malformed dev server URL — fall through to deny.
    }
  }

  return false;
}

/**
 * Lock a webContents down to app-owned content.
 *
 * The renderer runs sandboxed with context isolation, so a hostile page cannot
 * reach Node directly — but the preload bridge (`window.api`) is re-attached on
 * every navigation, and it exposes privileged IPC including local command
 * execution. Navigating this webContents to third-party content would therefore
 * hand that surface to a remote origin, so we deny it outright.
 *
 * External links are not broken: http/https/mailto targets are forwarded to the
 * user's default browser or mail client instead of opening in-app.
 *
 * Note: `will-navigate` does not fire for main-process-initiated loads
 * (loadURL / loadFile / reload), so normal app startup is unaffected.
 *
 * @param {Electron.WebContents} webContents
 * @param {{
 *   devServerUrl?: string|null,
 *   onBlocked?: (url: string) => void,
 *   openExternal?: (url: string) => Promise<unknown>,
 * }} [options]
 */
function applyNavigationGuard(webContents, options = {}) {
  const { devServerUrl = null, onBlocked = null, openExternal = defaultOpenExternal } = options;

  const forwardExternally = (url) => {
    if (!isAllowedExternalUrl(url)) return;
    Promise.resolve(openExternal(url)).catch(() => {});
  };

  const reportBlocked = (url) => {
    if (typeof onBlocked === "function") {
      try {
        onBlocked(url);
      } catch {
        // Logging must never break navigation handling.
      }
    }
  };

  webContents.on("will-navigate", (event, url) => {
    if (isInternalUrl(url, devServerUrl)) return;

    event.preventDefault();
    reportBlocked(url);
    forwardExternally(url);
  });

  webContents.setWindowOpenHandler(({ url }) => {
    reportBlocked(url);
    forwardExternally(url);
    return { action: "deny" };
  });

  // No feature uses <webview>; refuse to let one be attached with weakened
  // settings if a page ever tries.
  webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
    reportBlocked("webview");
  });
}

module.exports = {
  ALLOWED_EXTERNAL_PROTOCOLS,
  isAllowedExternalUrl,
  isInternalUrl,
  applyNavigationGuard,
};
