"use strict";

const fs = require("fs");
const path = require("path");

/** Folder levels below home that the search reads. */
const SEARCH_DEPTH = 3;

/**
 * True when `folder` is a single folder name a window title could show.
 *
 * @param {unknown} folder
 * @returns {boolean}
 */
function isPlainFolderName(folder) {
  if (typeof folder !== "string") return false;
  const name = folder.trim();
  if (!name || name.length > 255) return false;
  if (name === "." || name === "..") return false;
  return !name.includes("/") && !name.includes("\\");
}

/**
 * Find the file an editor's window title points at.
 *
 * A title shows the open file's name and its project folder, never its path,
 * and the same name is common across projects (index.js, README.md). So a file
 * only counts when it sits somewhere inside a folder with the project's name,
 * and the search gives up when a second one turns up: reading either could put
 * the wrong file's contents in the AI prompt.
 *
 * Hidden folders (starting with ".") are skipped to keep the scan short.
 *
 * @param {string} filename  File name from the title, e.g. "App.jsx".
 * @param {string} folder    Project folder from the title, e.g. "privoca".
 * @param {string} homeDir   Where the search starts.
 * @param {{ fsMod?: typeof fs, maxDepth?: number }} [options]
 * @returns {{ path: string|null, reason?: string }}
 */
function findEditorFile(filename, folder, homeDir, options = {}) {
  if (!isPlainFolderName(folder)) {
    return { path: null, reason: "window title names no project folder" };
  }

  const fsMod = options.fsMod || fs;
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : SEARCH_DEPTH;
  const wantedFolder = folder.trim().toLowerCase();
  const matches = [];

  const walk = (dir, depth, insideFolder) => {
    let entries;
    try {
      entries = fsMod.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Permission denied or other fs error - skip silently
    }
    for (const entry of entries) {
      if (matches.length > 1) return;
      if (entry.name.startsWith(".")) continue;
      if (entry.isFile()) {
        if (insideFolder && entry.name === filename) matches.push(path.join(dir, entry.name));
      } else if (entry.isDirectory() && depth < maxDepth) {
        const inside = insideFolder || entry.name.toLowerCase() === wantedFolder;
        walk(path.join(dir, entry.name), depth + 1, inside);
      }
    }
  };

  walk(homeDir, 0, false);

  if (matches.length === 1) return { path: matches[0] };
  if (matches.length > 1) {
    return { path: null, reason: "more than one file with that name in that project folder" };
  }
  return { path: null, reason: "file not found in home dir" };
}

module.exports = { findEditorFile, isPlainFolderName, SEARCH_DEPTH };
