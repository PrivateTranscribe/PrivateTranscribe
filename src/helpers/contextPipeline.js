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
import { hasTesterAccess } from "../hooks/useProStatus";

/** Default IPC timeout – short enough to never stall transcription. */
const DEFAULT_TIMEOUT_MS = 300;

/** Max window-title length included in Whisper hints (keeps prompt terse). */
const WHISPER_TITLE_MAX = 80;

// ─── Settings helpers ────────────────────────────────────────────────────────

/**
 * Returns true when Smart Context (window title + app name) is enabled.
 *
 * Key priority:
 *  1. `smartContextEnabled` (new key, default true for Pro)
 *  2. `enableContextCapture` (legacy key, backward compat)
 *  3. `includeActiveWindowContextInReasoning` (oldest legacy key)
 *
 * Always requires Pro entitlement.
 *
 * @returns {boolean}
 */
export function isSmartContextEnabled() {
  if (typeof window === "undefined" || !window.localStorage) return false;
  try {
    if (!hasTesterAccess()) return false;
    const v = window.localStorage.getItem("smartContextEnabled");
    if (v === "true") return true;
    if (v === "false") return false;
    // Backwards compat: older builds used enableContextCapture
    const v2 = window.localStorage.getItem("enableContextCapture");
    if (v2 === "true") return true;
    if (v2 === "false") return false;
    // Oldest legacy key
    return window.localStorage.getItem("includeActiveWindowContextInReasoning") === "true";
  } catch {
    return false;
  }
}

/**
 * Returns true when file identifier extraction is enabled.
 *
 * Requires Smart Context to also be enabled.
 *
 * @returns {boolean}
 */
export function isFileIdentifiersEnabled() {
  if (!isSmartContextEnabled()) return false;
  try {
    return window.localStorage.getItem("enableFileIdentifiers") === "true";
  } catch {
    return false;
  }
}

/**
 * Returns true when LLM Context Enhancement is enabled.
 * This is the separate toggle for feeding context to the reasoning LLM.
 * Does NOT require Smart Context — it has its own Pro gate.
 *
 * @returns {boolean}
 */
export function isLlmContextEnhancementEnabled() {
  if (typeof window === "undefined" || !window.localStorage) return false;
  try {
    if (!hasTesterAccess()) return false;
    return window.localStorage.getItem("llmContextEnhancement") === "true";
  } catch {
    return false;
  }
}

/**
 * Returns true when active file content should be included in LLM context.
 * Requires LLM Context Enhancement to already be enabled.
 *
 * @returns {boolean}
 */
export function isLlmFileContentEnabled() {
  if (!isLlmContextEnhancementEnabled()) return false;
  try {
    return window.localStorage.getItem("includeFileContentInLlmContext") === "true";
  } catch {
    return false;
  }
}

// ─── Filename parsing ─────────────────────────────────────────────────────────

/**
 * Common window title patterns for extracting the active filename.
 *
 * VS Code default:  "filename.ext — rootName — Visual Studio Code"
 * Sublime / Atom:   "filename.ext - AppName"
 * JetBrains IDEs:   "filename.ext [project] - AppName"
 */
const FILENAME_TITLE_PATTERNS = [
  // VS Code em-dash separator (most common)
  /^([\w][\w. -]*\.\w+)\s*[—–]/,
  // Regular hyphen separator (Sublime Text, Atom, etc.)
  /^([\w][\w. -]*\.\w+)\s+-\s+\w/,
  // JetBrains square bracket style
  /^([\w][\w. -]*\.\w+)\s+\[/,
];

/**
 * Parse a filename from a window title string.
 *
 * @example
 * parseFilenameFromTitle("App.jsx — privoca — Visual Studio Code")
 * // → "App.jsx"
 *
 * @param {string|null|undefined} windowTitle
 * @returns {string|null}
 */
export function parseFilenameFromTitle(windowTitle) {
  if (!windowTitle) return null;
  const trimmed = windowTitle.trim();
  for (const pattern of FILENAME_TITLE_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (match) return match[1].trim();
  }
  return null;
}

// ─── File identifier extraction ───────────────────────────────────────────────

/**
 * Extract source-code identifiers from the active file (opt-in, local only).
 *
 * Calls the main-process IPC handler which handles filesystem access,
 * home-dir safety checks, and size limits.
 *
 * @param {string|null|undefined} windowTitle  Active window title (used to derive filename).
 * @param {object}  [options]
 * @param {number}  [options.timeoutMs=200]  Max wait in ms.
 *
 * @returns {Promise<FileIdentifiersResult>}
 *
 * @typedef {object} FileIdentifiersResult
 * @property {boolean}   available
 * @property {string[]}  [identifiers]
 * @property {string}    [filename]
 * @property {string}    [reason]
 */
export async function extractFileIdentifiers(windowTitle, options = {}) {
  const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 200;

  const filename = parseFilenameFromTitle(windowTitle);
  if (!filename) {
    return { available: false, reason: "no filename found in window title" };
  }

  try {
    const ipcFn = window?.electronAPI?.extractFileIdentifiers;
    if (typeof ipcFn !== "function") {
      return { available: false, reason: "IPC not available" };
    }

    const ipcPromise = ipcFn(filename).then((result) => {
      if (!result) return { available: false, reason: "no result from IPC" };
      if (result.blocked) return { available: false, reason: result.reason };
      return {
        available: true,
        identifiers: result.identifiers || [],
        filename: result.filename || filename,
      };
    });

    const timeoutPromise = new Promise((resolve) =>
      setTimeout(
        () => resolve({ available: false, reason: "file identifier extraction timed out" }),
        timeoutMs
      )
    );

    return await Promise.race([ipcPromise, timeoutPromise]);
  } catch (err) {
    return { available: false, reason: err?.message || String(err) };
  }
}

export async function extractFileContent(windowTitle, options = {}) {
  const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 250;
  const maxChars = typeof options.maxChars === "number" ? options.maxChars : 4000;

  const filename = parseFilenameFromTitle(windowTitle);
  if (!filename) {
    return { available: false, reason: "no filename found in window title" };
  }

  try {
    const ipcFn = window?.electronAPI?.extractFileContext;
    if (typeof ipcFn !== "function") {
      return { available: false, reason: "IPC not available" };
    }

    const ipcPromise = ipcFn(filename, { maxChars }).then((result) => {
      if (!result) return { available: false, reason: "no result from IPC" };
      if (result.blocked) return { available: false, reason: result.reason };
      if (!result.excerpt)
        return { available: false, reason: result.reason || "empty file excerpt" };
      return {
        available: true,
        filename: result.filename || filename,
        excerpt: result.excerpt,
        truncated: result.truncated === true,
        originalLength: result.originalLength,
      };
    });

    const timeoutPromise = new Promise((resolve) =>
      setTimeout(
        () => resolve({ available: false, reason: "file content extraction timed out" }),
        timeoutMs
      )
    );

    return await Promise.race([ipcPromise, timeoutPromise]);
  } catch (err) {
    return { available: false, reason: err?.message || String(err) };
  }
}

// ─── Context fetch ────────────────────────────────────────────────────────────

/**
 * Fetch the active window context via IPC with a hard timeout.
 *
 * Always resolves; never rejects. On error or timeout the returned object has
 * `available: false` and a `reason` describing why.
 *
 * @param {object}  [options]
 * @param {number}  [options.timeoutMs=300]          Max wait in ms before giving up.
 * @param {boolean} [options.includeFileIdentifiers]  When true, also extracts file identifiers
 *                                                    (ignored unless `isFileIdentifiersEnabled()`)
 *
 * @returns {Promise<ContextResult>}
 *
 * @typedef {object} ContextResult
 * @property {boolean}          available
 * @property {string}           source       - "ipc" | "timeout" | "error" | "unavailable"
 * @property {string}           [appName]
 * @property {string}           [windowTitle]
 * @property {string}           [processName]
 * @property {string}           [appClass]
 * @property {string}           [uiaText]
 * @property {string}           [platform]
 * @property {boolean}          [blocked]
 * @property {string}           [reason]
 * @property {FileIdentifiersResult} [fileIdentifiers]
 */
export async function getContext(options = {}) {
  const timeoutMs =
    typeof options.timeoutMs === "number" && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  let ctx;
  try {
    const ipcFn = window?.electronAPI?.getActiveWindowContext;
    if (typeof ipcFn !== "function") {
      ctx = { available: false, source: "unavailable", reason: "IPC not available" };
    } else {
      /** @type {Promise<ContextResult>} */
      const ipcPromise = ipcFn().then((raw) => {
        if (!raw) return { available: false, source: "unavailable", reason: "no result" };
        return { ...raw, source: "ipc" };
      });

      /** @type {Promise<ContextResult>} */
      const timeoutPromise = new Promise((resolve) =>
        setTimeout(
          () => resolve({ available: false, source: "timeout", reason: "context fetch timed out" }),
          timeoutMs
        )
      );

      ctx = await Promise.race([ipcPromise, timeoutPromise]);
    }
  } catch (err) {
    logger.debug(
      "contextPipeline.getContext error",
      { error: err?.message || String(err) },
      "transcription"
    );
    ctx = { available: false, source: "error", reason: err?.message || String(err) };
  }

  // Optionally fetch file identifiers (opt-in, local only)
  const wantFileIdentifiers =
    options.includeFileIdentifiers !== false && isFileIdentifiersEnabled();

  if (wantFileIdentifiers && ctx?.available && ctx?.windowTitle) {
    try {
      const fileCtx = await extractFileIdentifiers(ctx.windowTitle, { timeoutMs: 200 });
      ctx = { ...ctx, fileIdentifiers: fileCtx };
    } catch {
      // Non-fatal — just omit file identifiers
      ctx = { ...ctx, fileIdentifiers: { available: false, reason: "extraction failed" } };
    }
  }

  return ctx;
}

// ─── Whisper hint builders ────────────────────────────────────────────────────

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

/**
 * Build a terse identifier hint for Whisper's `initialPrompt`.
 *
 * @param {FileIdentifiersResult|null|undefined} fileCtx
 * @returns {string|null}
 */
export function buildFileIdentifierHint(fileCtx) {
  if (!fileCtx?.available || !fileCtx.identifiers?.length) return null;
  const sample = fileCtx.identifiers.slice(0, 15).join(" ");
  return `Identifiers: ${sample}`;
}
