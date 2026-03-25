/**
 * contextPipeline — shared Smart Context helper
 *
 * Single entry point for fetching the active window context with a hard timeout
 * so the transcription path is never blocked. Consumed by both AudioManager
 * (Whisper initialPrompt hints) and ReasoningService (reasoning context block).
 *
 * @module contextPipeline
 */

import logger from "../utils/logger";
import { getEffectiveEntitlement } from "../hooks/useProStatus";

/** Default IPC timeout – short enough to never stall transcription. */
const DEFAULT_TIMEOUT_MS = 300;

/** Max window-title length included in Whisper hints (keeps prompt terse). */
const WHISPER_TITLE_MAX = 80;

/**
 * Returns true when Smart Context is enabled for the current session.
 *
 * Requires:
 *  - Pro entitlement
 *  - `enableContextCapture` localStorage flag set to "true"
 *    (or legacy `includeActiveWindowContextInReasoning` === "true")
 *
 * Safe to call in any environment; returns false outside a browser context.
 *
 * @returns {boolean}
 */
export function isSmartContextEnabled() {
  if (typeof window === "undefined" || !window.localStorage) return false;
  try {
    if (getEffectiveEntitlement() !== "pro") return false;
    const v = window.localStorage.getItem("enableContextCapture");
    if (v === "true") return true;
    if (v === "false") return false;
    // Backwards compat: older builds used this key
    return window.localStorage.getItem("includeActiveWindowContextInReasoning") === "true";
  } catch {
    return false;
  }
}

/**
 * Fetch the active window context via IPC with a hard timeout.
 *
 * Always resolves; never rejects. On error or timeout the returned object has
 * `available: false` and a `reason` describing why.
 *
 * @param {object}  [options]
 * @param {number}  [options.timeoutMs=300]  Max wait in ms before giving up.
 *
 * @returns {Promise<ContextResult>}
 *
 * @typedef {object} ContextResult
 * @property {boolean}  available
 * @property {string}   source       - "ipc" | "timeout" | "error" | "unavailable"
 * @property {string}   [appName]
 * @property {string}   [windowTitle]
 * @property {string}   [processName]
 * @property {string}   [appClass]
 * @property {string}   [uiaText]
 * @property {string}   [platform]
 * @property {boolean}  [blocked]
 * @property {string}   [reason]
 */
export async function getContext(options = {}) {
  const timeoutMs =
    typeof options.timeoutMs === "number" && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  try {
    const ipcFn = window?.electronAPI?.getActiveWindowContext;
    if (typeof ipcFn !== "function") {
      return { available: false, source: "unavailable", reason: "IPC not available" };
    }

    /** @type {Promise<ContextResult>} */
    const ipcPromise = ipcFn().then((ctx) => {
      if (!ctx) return { available: false, source: "unavailable", reason: "no result" };
      return { ...ctx, source: "ipc" };
    });

    /** @type {Promise<ContextResult>} */
    const timeoutPromise = new Promise((resolve) =>
      setTimeout(
        () => resolve({ available: false, source: "timeout", reason: "context fetch timed out" }),
        timeoutMs,
      ),
    );

    return await Promise.race([ipcPromise, timeoutPromise]);
  } catch (err) {
    logger.debug(
      "contextPipeline.getContext error",
      { error: err?.message || String(err) },
      "transcription",
    );
    return {
      available: false,
      source: "error",
      reason: err?.message || String(err),
    };
  }
}

/**
 * Build a terse hint string suitable for Whisper's `initialPrompt`.
 *
 * UIA/focused-element text is intentionally excluded — it is too verbose for
 * a Whisper hint and can degrade transcription quality.
 *
 * @param {ContextResult|null|undefined} ctx
 * @returns {string|null}  Null when no useful context is available.
 */
export function buildWhisperContextHint(ctx) {
  if (!ctx?.available) return null;

  const parts = [];

  const appLabel = ctx.appName || ctx.processName || ctx.appClass || null;
  if (appLabel) parts.push(`App: ${appLabel}`);

  if (ctx.windowTitle) {
    const title =
      ctx.windowTitle.length > WHISPER_TITLE_MAX
        ? ctx.windowTitle.slice(0, WHISPER_TITLE_MAX - 3) + "..."
        : ctx.windowTitle;
    parts.push(`Window: ${title}`);
  }

  return parts.length > 0 ? parts.join(", ") : null;
}
