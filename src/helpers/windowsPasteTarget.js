"use strict";

const fs = require("fs");
const path = require("path");

const FAST_PASTE_EXECUTABLE = "windows-fast-paste.exe";

/**
 * What the helper observed, which is a different question from whether the
 * paste worked. "absent" means it watched the focused field and the text never
 * arrived. "none" means it could not read the field at all, so nothing about
 * the paste can be claimed in either direction.
 */
const PASTE_EVIDENCE_ABSENT = "absent";
const PASTE_EVIDENCE_NONE = "none";

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
      // Only the exact string "none" means the helper could not see the target
      // and knows nothing. Anything else, a missing field from an older helper
      // included, keeps the louder "we think the paste failed" handling.
      evidence:
        parsed.evidence === PASTE_EVIDENCE_NONE ? PASTE_EVIDENCE_NONE : PASTE_EVIDENCE_ABSENT,
      dispatched: parsed.dispatched === true,
      // Agent Mode's spoken "send". Only a literal true from the helper counts;
      // an older helper never writes the field and never pressed Enter.
      enterSent: parsed.enterSent === true,
      isTerminal: parsed.isTerminal === true,
      windowClass: typeof parsed.windowClass === "string" ? parsed.windowClass.slice(0, 128) : "",
      processName: typeof parsed.processName === "string" ? parsed.processName.slice(0, 128) : "",
    };
  } catch {
    return {
      pasted: false,
      evidence: PASTE_EVIDENCE_ABSENT,
      dispatched: false,
      enterSent: false,
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
    error.evidence = result.evidence;
    error.enterSent = result.enterSent;
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
  PASTE_EVIDENCE_ABSENT,
  PASTE_EVIDENCE_NONE,
  getWindowsFastPasteExecutablePaths,
  getWindowsPasteShortcut,
  parseWindowsFastPasteOutput,
  resolveWindowsFastPasteExecutable,
};
