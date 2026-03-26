"use strict";

const fs = require("fs");
const path = require("path");
const { isSafeFilePath, isFileTooLarge } = require("./fileIdentifierExtractor");

const DEFAULT_MAX_CHARS = 4000;

function sanitizeFileContent(content, maxChars = DEFAULT_MAX_CHARS) {
  const normalized = String(content || "").replace(/\r\n?/g, "\n");
  if (normalized.length <= maxChars) {
    return { excerpt: normalized, truncated: false, originalLength: normalized.length };
  }

  return {
    excerpt: `${normalized.slice(0, maxChars)}\n\n[...truncated for prompt size]`,
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
