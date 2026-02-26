"use strict";

/**
 * Context sanitization utilities.
 *
 * Goal: allow us to capture useful window/app context while reducing the risk of
 * accidental collection of sensitive values (passwords, API keys, secrets).
 *
 * This module is intentionally dependency-free and safe to use in both Electron
 * main/renderer.
 */

const DEFAULT_REDACTION_PATTERNS = [
  // password: hunter2 / password=hunter2
  {
    name: "password",
    // capture only the value so we can preserve the field name for usefulness
    regex: /(password\s*[:=]\s*)([^\s'"\n\r]+)/gi,
    replacement: "$1[REDACTED]",
  },
  // apiKey: ... / api_key=...
  {
    name: "apiKey",
    regex: /(api[_-]?key\s*[:=]\s*)([^\s'"\n\r]+)/gi,
    replacement: "$1[REDACTED]",
  },
  // Bearer tokens in logs/headers.
  {
    name: "bearerToken",
    regex: /(authorization\s*[:=]\s*bearer\s+)([^\s'"\n\r]+)/gi,
    replacement: "$1[REDACTED]",
  },
  // Common OpenAI-style keys
  {
    name: "skKey",
    regex: /\bsk-[A-Za-z0-9]{20,}\b/g,
    replacement: "[REDACTED]",
  },
  // Emails (can appear in window titles, docs, tickets, etc.)
  {
    name: "email",
    regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    replacement: "[REDACTED_EMAIL]",
  },
  // URLs with query strings (query params often contain tokens/ids/search terms)
  {
    name: "urlQuery",
    regex: /(https?:\/\/[\w\-._~%!$&'()*+,;=:@/]+)\?([^\s'"\n\r]+)/gi,
    replacement: "$1?[REDACTED_QUERY]",
  },
  // Long hex/base64-ish tokens (hashes, ids, secrets). Keep it conservative.
  {
    name: "longHexToken",
    regex: /\b[a-f0-9]{32,}\b/gi,
    replacement: "[REDACTED]",
  },
];

function truncateUtf8Safe(text, maxChars) {
  if (typeof text !== "string") return "";
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  if (text.length <= maxChars) return text;

  // This truncation is code-unit based; good enough for our use (we want to
  // avoid huge payloads), but keep the function separate so we can improve it
  // later if needed.
  return text.slice(0, maxChars);
}

/**
 * @param {string} text
 * @param {{
 *   maxChars?: number,
 *   redactionPatterns?: Array<{name?: string, regex: RegExp, replacement: string}>
 * }} [options]
 */
function sanitizeContextText(text, options = {}) {
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : 8000;
  const patterns = Array.isArray(options.redactionPatterns)
    ? options.redactionPatterns
    : DEFAULT_REDACTION_PATTERNS;

  let output = typeof text === "string" ? text : "";

  for (const pattern of patterns) {
    if (!pattern || !(pattern.regex instanceof RegExp) || typeof pattern.replacement !== "string") {
      continue;
    }
    output = output.replace(pattern.regex, pattern.replacement);
  }

  output = truncateUtf8Safe(output, maxChars);
  return output;
}

module.exports = {
  DEFAULT_REDACTION_PATTERNS,
  sanitizeContextText,
};
