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
  // Generic "Bearer <token>" fragments (often show up without the Authorization label).
  // Keep it conservative by requiring a token-like shape and minimum length.
  {
    name: "genericBearerToken",
    regex: /(\bbearer\s+)([A-Za-z0-9._-]{10,})\b/gi,
    replacement: "$1[REDACTED]",
  },
  // Common OpenAI-style keys
  {
    name: "skKey",
    regex: /\bsk-[A-Za-z0-9]{20,}\b/g,
    replacement: "[REDACTED]",
  },
  // Stripe keys / secrets
  {
    name: "stripeSecretKey",
    regex: /\bsk_(?:live|test)_[0-9A-Za-z]{10,}\b/g,
    replacement: "[REDACTED_STRIPE_KEY]",
  },
  {
    name: "stripePublishableKey",
    regex: /\bpk_(?:live|test)_[0-9A-Za-z]{10,}\b/g,
    replacement: "[REDACTED_STRIPE_KEY]",
  },
  {
    name: "stripeWebhookSecret",
    regex: /\bwhsec_[0-9A-Za-z]{10,}\b/g,
    replacement: "[REDACTED_STRIPE_WEBHOOK_SECRET]",
  },
  // Google API keys (often show up in URLs/config)
  {
    name: "googleApiKey",
    // Typical Google API keys are 39 chars total ("AIza" + 35), but allow
    // a small range to avoid missing real keys.
    regex: /\bAIza[0-9A-Za-z_-]{30,40}\b/g,
    replacement: "[REDACTED_GOOGLE_API_KEY]",
  },
  // Google OAuth access tokens (often start with ya29.)
  {
    name: "googleOAuthToken",
    regex: /\bya29\.[0-9A-Za-z_-]{20,}\b/g,
    replacement: "[REDACTED_GOOGLE_OAUTH_TOKEN]",
  },
  // JWTs (common in auth headers, logs, debug output)
  {
    name: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: "[REDACTED_JWT]",
  },
  // AWS access key ids (often pasted into terminals, logs, dashboards)
  {
    name: "awsAccessKeyId",
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED_AWS_KEY]",
  },
  // GitHub personal access tokens (classic + fine-grained)
  {
    name: "githubTokenClassic",
    regex: /\bghp_[A-Za-z0-9]{20,}\b/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    name: "githubTokenFineGrained",
    regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  // Slack tokens (bot/user/app tokens commonly start with xox*)
  {
    name: "slackToken",
    regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
    replacement: "[REDACTED_SLACK_TOKEN]",
  },
  // PEM private key blocks
  {
    name: "privateKeyBlock",
    regex:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
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
