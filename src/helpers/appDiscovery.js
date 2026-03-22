"use strict";

/**
 * App Discovery - platform-specific installed application scanner.
 *
 * Scans OS-specific locations to build a sorted list of { name, path } pairs
 * for the Action Engine "Open application" action picker UI.
 *
 * Pure helpers (parseDesktopFile, extractAppNameFromPath, filterApps) are
 * exported separately so they can be unit-tested without any filesystem or
 * Electron dependencies.
 *
 * @module helpers/appDiscovery
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for tests)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract a human-friendly display name from a file system path.
 *
 * - macOS  : strips trailing ".app"  (e.g. "Safari.app" → "Safari")
 * - Windows: strips ".exe", ".lnk", ".bat" (e.g. "notepad.exe" → "notepad")
 * - Linux  : returns the basename unchanged
 *
 * @param {string} filePath
 * @param {string} platform  "darwin" | "win32" | "linux"
 * @returns {string}
 */
function extractAppNameFromPath(filePath, platform) {
  if (typeof filePath !== "string" || !filePath) return "";
  // Split on both forward and back slashes so this helper works correctly when
  // called from tests running on a different OS (e.g. testing Windows paths on Linux).
  const parts = filePath.split(/[/\\]/);
  const base = parts[parts.length - 1] ?? "";
  if (platform === "darwin" && base.endsWith(".app")) {
    return base.slice(0, -4);
  }
  if (platform === "win32") {
    return base.replace(/\.(exe|lnk|bat)$/i, "");
  }
  return base;
}

/**
 * Parse a freedesktop .desktop file and return `{ name, exec }` or null.
 *
 * Rules:
 *   - Only parses the [Desktop Entry] section.
 *   - Returns null for hidden entries (Hidden=true or NoDisplay=true).
 *   - Returns null when Name or Exec is missing.
 *   - Strips freedesktop field codes (%u, %f, %F, etc.) from Exec.
 *   - Handles "env VAR=value cmd …" wrapper pattern.
 *
 * @param {string} content  Raw .desktop file text.
 * @returns {{ name: string, exec: string } | null}
 */
function parseDesktopFile(content) {
  if (typeof content !== "string") return null;

  const lines = content.split(/\r?\n/);
  let inDesktopEntry = false;
  let name = null;
  let exec = null;
  let hidden = false;
  let noDisplay = false;
  let type = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "[Desktop Entry]") {
      inDesktopEntry = true;
      continue;
    }
    // Entering a different section - stop reading Desktop Entry fields.
    if (trimmed.startsWith("[") && trimmed !== "[Desktop Entry]") {
      if (inDesktopEntry) break;
      continue;
    }

    if (!inDesktopEntry) continue;
    if (trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();

    // Only capture the first occurrence of each key (locale variants come later).
    if (key === "Name" && name === null) name = value;
    if (key === "Exec" && exec === null) exec = value;
    if (key === "Type" && type === null) type = value;
    if (key === "Hidden" && value.toLowerCase() === "true") hidden = true;
    if (key === "NoDisplay" && value.toLowerCase() === "true") noDisplay = true;
  }

  // Only handle Application entries with a name and exec command.
  if (!name || !exec || hidden || noDisplay) return null;
  if (type && type !== "Application") return null;

  // Strip freedesktop field codes (e.g. %u, %f, %F, %i, %c, %k).
  const cleanExec = exec.replace(/%[a-zA-Z%]/g, "").trim();

  // Find the actual executable, skipping any leading "env VAR=value" pairs.
  const parts = cleanExec.split(/\s+/);
  let execPath = parts[0] ?? "";
  if (execPath === "env") {
    execPath = parts.find((p, i) => i > 0 && !p.includes("=")) ?? parts[1] ?? "";
  }

  if (!execPath) return null;
  return { name, exec: execPath };
}

/**
 * Filter a list of apps by a query string (case-insensitive).
 * Prefix matches are sorted before substring matches.
 *
 * @param {{ name: string, path: string }[]} apps
 * @param {string} query
 * @returns {{ name: string, path: string }[]}
 */
function filterApps(apps, query) {
  if (!Array.isArray(apps)) return [];
  const q = (typeof query === "string" ? query : "").trim().toLowerCase();
  if (!q) return apps;

  const prefix = [];
  const contains = [];
  for (const app of apps) {
    const lower = (app.name ?? "").toLowerCase();
    if (lower.startsWith(q)) prefix.push(app);
    else if (lower.includes(q)) contains.push(app);
  }
  return [...prefix, ...contains];
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform-specific scanners
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scan macOS /Applications and ~/Applications for .app bundles.
 * @returns {{ name: string, path: string }[]}
 */
function _scanMacOS() {
  const dirs = ["/Applications", path.join(os.homedir(), "Applications")];
  const results = new Map();

  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.name.endsWith(".app")) continue;
      const appName = entry.name.slice(0, -4);
      if (!results.has(appName)) {
        results.set(appName, { name: appName, path: path.join(dir, entry.name) });
      }
    }
  }

  return [...results.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Scan Windows Start Menu shortcuts and Program Files for executables.
 * @returns {{ name: string, path: string }[]}
 */
function _scanWindows() {
  const startMenuDirs = [
    process.env["APPDATA"]
      ? path.join(process.env["APPDATA"], "Microsoft", "Windows", "Start Menu", "Programs")
      : null,
    "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
  ].filter(Boolean);

  const programDirs = [
    process.env["ProgramFiles"] || "C:\\Program Files",
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    process.env["LOCALAPPDATA"] ? path.join(process.env["LOCALAPPDATA"], "Programs") : null,
  ].filter(Boolean);

  const results = new Map();

  // Start Menu .lnk files are the cleanest source of well-named apps.
  for (const dir of startMenuDirs) {
    _scanDirRecursive(dir, [".lnk"], 4, results, "win32");
  }

  // Program Files .exe files as supplementary source (top-level dirs only).
  for (const dir of programDirs) {
    _scanDirRecursive(dir, [".exe"], 2, results, "win32");
  }

  return [...results.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Scan Linux XDG .desktop directories for application entries.
 * @returns {{ name: string, path: string }[]}
 */
function _scanLinux() {
  const desktopDirs = [
    "/usr/share/applications",
    "/usr/local/share/applications",
    path.join(os.homedir(), ".local", "share", "applications"),
  ];
  const results = new Map();

  for (const dir of desktopDirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".desktop")) continue;
      const fullPath = path.join(dir, entry.name);
      let content;
      try {
        content = fs.readFileSync(fullPath, "utf8");
      } catch {
        continue;
      }

      const parsed = parseDesktopFile(content);
      if (!parsed) continue;
      // ~/.local overrides system entries - process dirs in ascending priority,
      // so later entries overwrite earlier ones for the same name.
      results.set(parsed.name, { name: parsed.name, path: parsed.exec });
    }
  }

  return [...results.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Recursively collect files with the given extensions from a directory.
 *
 * @param {string} dir
 * @param {string[]} extensions  Lower-case extensions including dot (e.g. [".exe"])
 * @param {number} maxDepth
 * @param {Map<string, { name: string, path: string }>} results  Mutated in place.
 * @param {string} platform
 */
function _scanDirRecursive(dir, extensions, maxDepth, results, platform) {
  if (maxDepth <= 0) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      _scanDirRecursive(fullPath, extensions, maxDepth - 1, results, platform);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (extensions.includes(ext)) {
        const appName = extractAppNameFromPath(fullPath, platform);
        if (appName && !results.has(appName)) {
          results.set(appName, { name: appName, path: fullPath });
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List installed applications for the current platform.
 *
 * Returns a sorted array of `{ name, path }` objects where `path` is the
 * value to pass to `shell.openPath()` (or the executable path on Linux).
 *
 * @returns {{ name: string, path: string }[]}
 */
function listInstalledApps() {
  const platform = process.platform;
  if (platform === "darwin") return _scanMacOS();
  if (platform === "win32") return _scanWindows();
  return _scanLinux();
}

module.exports = {
  listInstalledApps,
  // Pure helpers - exported for unit testing without Electron/filesystem deps
  extractAppNameFromPath,
  parseDesktopFile,
  filterApps,
};
