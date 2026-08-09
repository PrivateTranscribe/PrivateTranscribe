"use strict";

const fs = require("fs");
const path = require("path");

const FAST_PASTE_EXECUTABLE = "windows-fast-paste.exe";

/**
 * Candidate locations for the compiled fast paste helper, in priority order:
 * the packaged resources directory first, then the two development layouts.
 */
function getWindowsFastPasteExecutablePaths({
  resourcesPath = process.resourcesPath,
  cwd = process.cwd(),
  helpersDir = __dirname,
} = {}) {
  const candidates = [];
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, "bin", FAST_PASTE_EXECUTABLE));
  }
  candidates.push(
    path.join(helpersDir, "..", "..", "resources", "bin", FAST_PASTE_EXECUTABLE),
    path.join(cwd, "resources", "bin", FAST_PASTE_EXECUTABLE)
  );
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

function resolveWindowsFastPasteExecutable(options = {}) {
  const { existsSync = fs.existsSync, ...pathOptions } = options;
  const found = getWindowsFastPasteExecutablePaths(pathOptions).find((candidate) => {
    try {
      return existsSync(candidate);
    } catch {
      return false;
    }
  });
  return found || null;
}

/**
 * Parses the single JSON line the helper writes. Detection is best effort, so an
 * unreadable line degrades to "not a terminal" rather than failing the paste.
 */
function parseWindowsFastPasteOutput(stdout) {
  try {
    const parsed = JSON.parse(String(stdout || "").trim());
    return {
      pasted: parsed.pasted === true,
      dispatched: parsed.dispatched === true,
      isTerminal: parsed.isTerminal === true,
      windowClass: typeof parsed.windowClass === "string" ? parsed.windowClass.slice(0, 128) : "",
      processName: typeof parsed.processName === "string" ? parsed.processName.slice(0, 128) : "",
    };
  } catch {
    return {
      pasted: false,
      dispatched: false,
      isTerminal: false,
      windowClass: "",
      processName: "",
    };
  }
}

function assertWindowsFastPasteSucceeded(stdout) {
  const result = parseWindowsFastPasteOutput(stdout);
  if (!result.pasted) {
    const error = new Error(
      "Windows paste helper did not confirm text insertion. The transcription remains copied to the clipboard."
    );
    error.code = "WINDOWS_PASTE_NOT_CONFIRMED";
    error.dispatched = result.dispatched;
    throw error;
  }
  return result;
}

/**
 * Paste chord for the nircmd/PowerShell fallback path, used only when the helper
 * is unavailable. Without the helper there is no target detection, so this
 * defaults to the ordinary Ctrl+V that shipped before terminal support existed.
 */
function getWindowsPasteShortcut({ isTerminal = false } = {}) {
  return isTerminal
    ? { isTerminal: true, nircmdKeys: "ctrl+shift+v", sendKeys: "^+v" }
    : { isTerminal: false, nircmdKeys: "ctrl+v", sendKeys: "^v" };
}

module.exports = {
  assertWindowsFastPasteSucceeded,
  FAST_PASTE_EXECUTABLE,
  getWindowsFastPasteExecutablePaths,
  getWindowsPasteShortcut,
  parseWindowsFastPasteOutput,
  resolveWindowsFastPasteExecutable,
};
