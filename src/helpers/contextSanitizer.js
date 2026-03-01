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
  // password: hunter2 / password=hunter2 / password: "hunter two"
  {
    name: "password",
    // capture only the value so we can preserve the field name for usefulness
    // Support quoted values (including spaces) to avoid leaking real passwords
    // in config snippets, JSON-like logs, or terminal output.
    regex: /(password\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s'"\n\r]+)/gi,
    replacement: "$1[REDACTED]",
  },
  // passwd/pwd are common shorthands
  {
    name: "passwd",
    regex: /(pass(?:wd)?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s'"\n\r]+)/gi,
    replacement: "$1[REDACTED]",
  },
  {
    name: "pwd",
    regex: /(\bpwd\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s'"\n\r]+)/gi,
    replacement: "$1[REDACTED]",
  },
  // Generic secret/token fields (keep narrow: require key + :=)
  {
    name: "secretField",
    regex: /(\bsecret\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s'"\n\r]+)/gi,
    replacement: "$1[REDACTED]",
  },
  {
    name: "tokenField",
    regex: /(\btoken\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s'"\n\r]+)/gi,
    replacement: "$1[REDACTED]",
  },
  // 2FA / verification codes (keep narrow to avoid redacting dates/times)
  {
    name: "verificationCode",
    regex:
      /((?:verification|one[-\s]?time|security|auth|otp|2fa)\s*(?:code|passcode)\s*[:=]\s*)(\d{4,8})\b/gi,
    replacement: "$1[REDACTED_CODE]",
  },
  // apiKey: ... / api_key=...
  {
    name: "apiKey",
    regex: /(api[_-]?key\s*[:=]\s*)([^\s'"\n\r]+)/gi,
    replacement: "$1[REDACTED]",
  },
  // x-api-key / X_API_KEY (common header-style key name)
  {
    name: "xApiKey",
    regex: /(\bx[_-]?api[_-]?key\s*[:=]\s*)([^\s'"\n\r]+)/gi,
    replacement: "$1[REDACTED]",
  },
  // Common OAuth-ish / auth token fields (keep narrow to avoid redacting innocent text)
  {
    name: "oauthTokenFields",
    regex: /((?:access|refresh|id)[_-]?token\s*[:=]\s*)([^\s'"\n\r]+)/gi,
    replacement: "$1[REDACTED]",
  },
  {
    name: "clientSecret",
    regex: /(client[_-]?secret\s*[:=]\s*)([^\s'"\n\r]+)/gi,
    replacement: "$1[REDACTED]",
  },
  // Bearer tokens in logs/headers.
  {
    name: "bearerToken",
    regex: /(authorization\s*[:=]\s*bearer\s+)([^\s'"\n\r]+)/gi,
    replacement: "$1[REDACTED]",
  },
  // Basic auth tokens in logs/headers.
  {
    name: "basicAuthToken",
    regex: /(authorization\s*[:=]\s*basic\s+)([^\s'"\n\r]+)/gi,
    replacement: "$1[REDACTED]",
  },
  // Token auth scheme (commonly used by GitHub and various APIs).
  {
    name: "tokenAuthToken",
    regex: /(authorization\s*[:=]\s*token\s+)([^\s'"\n\r]+)/gi,
    replacement: "$1[REDACTED]",
  },
  // Proxy auth headers can also carry bearer/basic credentials.
  {
    name: "proxyBearerToken",
    regex: /(proxy-authorization\s*[:=]\s*bearer\s+)([^\s'"\n\r]+)/gi,
    replacement: "$1[REDACTED]",
  },
  {
    name: "proxyBasicAuthToken",
    regex: /(proxy-authorization\s*[:=]\s*basic\s+)([^\s'"\n\r]+)/gi,
    replacement: "$1[REDACTED]",
  },
  // Cookie headers can contain session identifiers and auth state.
  {
    name: "cookieHeader",
    regex: /(\bcookie\s*[:=]\s*)([^\n\r]+)/gi,
    replacement: "$1[REDACTED_COOKIES]",
  },
  {
    name: "setCookieHeader",
    regex: /(\bset-cookie\s*[:=]\s*)([^\n\r]+)/gi,
    replacement: "$1[REDACTED_COOKIES]",
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
    // Covers OpenAI/Anthropic-style keys like sk-..., sk-proj-..., sk-ant-...
    regex: /\bsk-[A-Za-z0-9-]{20,}\b/g,
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
    regex: /\b(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b/g,
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
  // Long base64-ish strings wrapped in quotes (often API keys / tokens in JSON)
  {
    name: "longQuotedSecret",
    regex: /(["'])([A-Za-z0-9+/=_-]{32,})(["'])/g,
    replacement: "$1[REDACTED_SECRET]$3",
  },
  // Long hex tokens (hashes, ids, secrets). Keep it conservative.
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

function luhnCheck(digits) {
  if (typeof digits !== "string" || !/^\d+$/.test(digits)) return false;
  let sum = 0;
  let shouldDouble = false;

  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (shouldDouble) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

function redactLikelyCardNumbers(text) {
  if (typeof text !== "string" || !text) return "";

  // Look for sequences that could be PANs with optional spaces/hyphens.
  // We Luhn-check to reduce false positives.
  const panLike = /\b(?:\d[ -]?){13,19}\d\b/g;

  return text.replace(panLike, (match) => {
    const digits = match.replace(/[^0-9]/g, "");
    if (digits.length < 13 || digits.length > 19) return match;
    if (!luhnCheck(digits)) return match;
    return "[REDACTED_CARD]";
  });
}

function redactUrlCredentials(text) {
  if (typeof text !== "string" || !text) return "";

  // Redact `scheme://user:pass@host` style credentials. Common in database URLs,
  // cloud service DSNs, and dev configs.
  const urlCredsRegex = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s\/:@]+):([^\s@\/]+)@/gi;

  return text.replace(urlCredsRegex, "$1$2:[REDACTED]@");
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

  // Redact embedded URL credentials early so later patterns (like email
  // redaction) don't partially mask/alter the URL.
  output = redactUrlCredentials(output);

  for (const pattern of patterns) {
    if (!pattern || !(pattern.regex instanceof RegExp) || typeof pattern.replacement !== "string") {
      continue;
    }
    output = output.replace(pattern.regex, pattern.replacement);
  }

  // PAN-like numbers can show up in focused fields or titles. Luhn-check to
  // reduce false positives before redacting.
  output = redactLikelyCardNumbers(output);

  output = truncateUtf8Safe(output, maxChars);
  return output;
}

module.exports = {
  DEFAULT_REDACTION_PATTERNS,
  sanitizeContextText,
};
