"use strict";

const fs = require("fs");
const path = require("path");
const { isSafeFilePath, isFileTooLarge } = require("./fileIdentifierExtractor");
const { sanitizeContextText } = require("./contextSanitizer");

const DEFAULT_MAX_CHARS = 4000;
// Text past the cut that is redacted with the excerpt, so a key or private key
// block (about 3.3 KB at most) that crosses the cut is caught whole.
const REDACTION_MARGIN_CHARS = 16 * 1024;

/**
 * The excerpt of an open file that goes into the AI prompt. Keys, tokens and
 * the other values the window context hides are redacted here the same way.
 * Only the part that can reach the excerpt is redacted, so the main process
 * does a bounded amount of work whatever the file holds.
 */
function sanitizeFileContent(content, maxChars = DEFAULT_MAX_CHARS) {
  const normalized = String(content || "").replace(/\r\n?/g, "\n");
  const scanned = normalized.slice(0, maxChars + REDACTION_MARGIN_CHARS);
  const redacted = sanitizeContextText(scanned, { maxChars: scanned.length });
  if (redacted.length <= maxChars && scanned.length === normalized.length) {
    return { excerpt: redacted, truncated: false, originalLength: normalized.length };
  }

  return {
    excerpt: `${redacted.slice(0, maxChars)}\n\n[...truncated for prompt size]`,
    truncated: true,
    originalLength: normalized.length,
  };
}

function extractFileContext(filePath, homeDir, fsMod, options = {}) {
  const fsImpl = fsMod || fs;
  const maxChars = typeof options.maxChars === "number" ? options.maxChars : DEFAULT_MAX_CHARS;

  if (!isSafeFilePath(filePath, homeDir)) {
    return { blocked: true, reason: "outside home dir" };
  }

  try {
    const stat = fsImpl.statSync(filePath);
    if (isFileTooLarge(stat.size)) {
      return { blocked: true, reason: "file too large" };
    }

    const content = fsImpl.readFileSync(filePath, "utf8");
    const { excerpt, truncated, originalLength } = sanitizeFileContent(content, maxChars);
    return {
      blocked: false,
      filename: path.basename(filePath),
      excerpt,
      truncated,
      originalLength,
    };
  } catch (err) {
    return { blocked: false, reason: `could not read file: ${err.message}` };
  }
}

module.exports = { DEFAULT_MAX_CHARS, sanitizeFileContent, extractFileContext };
