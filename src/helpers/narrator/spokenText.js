"use strict";

/**
 * The last guard before text reaches the voice or a card: secrets redacted
 * with the Smart Context redactor, then everything a listener cannot use taken
 * out of what is spoken. The rewriter is asked never to read code, paths or
 * links aloud; this makes sure of it when the model, or the fallback, does
 * anyway.
 */

const { sanitizeContextText } = require("../contextSanitizer");

const MAX_TEXT = 4000;

/** Secrets out; used for everything shown or spoken, and for what is sent to the rewriter. */
function redact(text, maxChars = MAX_TEXT) {
  return sanitizeContextText(String(text || ""), { maxChars });
}

const FENCED_CODE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE = /`([^`\n]{0,200})`/g;
const URL = /\b(?:https?|file|claude|ftp):\/\/[^\s)>\]]+/gi;
const WINDOWS_PATH = /(?:\b[A-Za-z]:|\\\\[^\\\s]+)[\\/][^\s,;:"')\]]*/g;
const UNIX_PATH = /(?:^|\s)(?:~|\.{1,2})?\/(?:[\w.-]+\/)+[\w.-]*/g;
const FILE_NAME =
  /\b[\w-]+(?:\.[\w-]+)*\.(?:jsx?|tsx?|mjs|cjs|py|json|ya?ml|md|css|html|ps1|sh|toml|lock|log|exe|dll|cs|go|rs|java|sql|txt)\b(?::\d+)?/gi;
const COMMIT_HASH = /\b[0-9a-f]{7,40}\b/g;
const REDACTION_MARK = /\[REDACTED[_A-Z]*\]/g;
const MARKDOWN = /[*_#>|]+/g;

/**
 * Text fit to be read aloud: redacted, no code, links, paths, file names or
 * hashes, no markdown marks, whitespace collapsed.
 */
function toSpeakable(text) {
  let spoken = redact(text)
    .replace(FENCED_CODE, " ")
    .replace(URL, " ")
    .replace(WINDOWS_PATH, " ")
    .replace(UNIX_PATH, " ")
    .replace(FILE_NAME, " ")
    .replace(INLINE_CODE, (_match, inner) => (/[(){}[\];=<>/\\]|\w\.\w/.test(inner) ? " " : inner))
    .replace(COMMIT_HASH, (hash) => (/\d/.test(hash) && /[a-f]/.test(hash) ? " " : hash))
    .replace(REDACTION_MARK, " ")
    .replace(MARKDOWN, " ");
  spoken = spoken
    .replace(/\(\s*\)/g, " ")
    .replace(/\s+([,.!?:;])/g, "$1")
    .replace(/([,:;])(?:\s*[,:;])+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return spoken;
}

/** Splits speech into sentences, so the first can play while the next is made. */
function splitSentences(text) {
  const parts = String(text || "")
    .split(/(?<=[.!?])\s+(?=[A-ZÆØÅ0-9"“])/u)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts;
}

module.exports = { redact, toSpeakable, splitSentences };
