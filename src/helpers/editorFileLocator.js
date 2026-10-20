"use strict";

const fs = require("fs");
const path = require("path");

/** Folder levels below home that the search reads. */
const SEARCH_DEPTH = 3;

/**
 * Folders no editor project lives in. Skipping them cut a search of a Windows
 * home from about 200 ms to 16 ms, time the main process is blocked for, and
 * keeps the search inside the 200-300 ms the renderer waits for it.
 */
const SKIPPED_FOLDERS = new Set(["appdata", "node_modules"]);

/**
 * Folders read before a search gives up and reads no file. A real Windows home
 * took 222 folders and 14 ms, so this bounds the time the main process is
 * blocked at a few times that, however full the home is.
 */
const MAX_FOLDERS_READ = 1000;

/**
 * A dictation looks the same file up twice, for its identifiers and for its
 * excerpt, so a result is reused for this long.
 */
const RESULT_CACHE_MS = 5000;
const RESULT_CACHE_ENTRIES = 32;
/** One result cache per fs module, so a test's fake file system has its own. */
const resultCaches = new WeakMap();

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
 * Hidden folders (starting with "."), AppData and node_modules are skipped to
 * keep the scan short. A search that would read more than MAX_FOLDERS_READ
 * folders reads no file, since a second match could be in the part it skipped.
 * A result is reused for RESULT_CACHE_MS.
 *
 * @param {string} filename  File name from the title, e.g. "App.jsx".
 * @param {string} folder    Project folder from the title, e.g. "privoca".
 * @param {string} homeDir   Where the search starts.
 * @param {{ fsMod?: typeof fs, maxDepth?: number, now?: () => number }} [options]
 * @returns {{ path: string|null, reason?: string }}
 */
function findEditorFile(filename, folder, homeDir, options = {}) {
  if (!isPlainFolderName(folder)) {
    return { path: null, reason: "window title names no project folder" };
  }

  const fsMod = options.fsMod || fs;
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : SEARCH_DEPTH;
  const now = typeof options.now === "function" ? options.now() : Date.now();
  let cache = resultCaches.get(fsMod);
  if (!cache) {
    cache = new Map();
    resultCaches.set(fsMod, cache);
  }
  const key = [homeDir, folder.trim().toLowerCase(), filename, maxDepth].join("\0");
  const cached = cache.get(key);
  if (cached && now - cached.at < RESULT_CACHE_MS) return { ...cached.result };

  const result = searchHome(filename, folder.trim().toLowerCase(), homeDir, fsMod, maxDepth);
  cache.delete(key);
  cache.set(key, { at: now, result });
  if (cache.size > RESULT_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  return { ...result };
}

function searchHome(filename, wantedFolder, homeDir, fsMod, maxDepth) {
  const matches = [];
  let foldersRead = 0;
  let gaveUp = false;

  const walk = (dir, depth, insideFolder) => {
    if (gaveUp) return;
    if (foldersRead >= MAX_FOLDERS_READ) {
      gaveUp = true;
      return;
    }
    foldersRead += 1;
    let entries;
    try {
      entries = fsMod.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Permission denied or other fs error - skip silently
    }
    for (const entry of entries) {
      if (gaveUp || matches.length > 1) return;
      if (entry.name.startsWith(".")) continue;
      if (entry.isFile()) {
        if (insideFolder && entry.name === filename) matches.push(path.join(dir, entry.name));
      } else if (
        entry.isDirectory() &&
        depth < maxDepth &&
        !SKIPPED_FOLDERS.has(entry.name.toLowerCase())
      ) {
        const inside = insideFolder || entry.name.toLowerCase() === wantedFolder;
        walk(path.join(dir, entry.name), depth + 1, inside);
      }
    }
  };

  walk(homeDir, 0, false);

  if (matches.length > 1) {
    return { path: null, reason: "more than one file with that name in that project folder" };
  }
  if (gaveUp) return { path: null, reason: "too many folders to search" };
  if (matches.length === 1) return { path: matches[0] };
  return { path: null, reason: "file not found in home dir" };
}

module.exports = { findEditorFile, isPlainFolderName, SEARCH_DEPTH, MAX_FOLDERS_READ };
