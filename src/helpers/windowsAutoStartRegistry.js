const { execFileSync } = require("child_process");

// Electron's `getLoginItemSettings` is not trustworthy on Windows:
// `executableWillLaunchAtLogin` reports true for an installed app that has no Run entry at
// all, and `launchItems` silently omits every entry whose stored path is quoted — which is
// exactly how Electron writes ours. Both made the settings toggle claim auto-start was on
// when nothing was registered, so it could never be switched on for real.
// The registry is the only authority, so read it directly.
const RUN_KEY = ["HKCU", "Software", "Microsoft", "Windows", "CurrentVersion", "Run"].join("\\");
const APPROVED_KEY = [
  "HKCU",
  "Software",
  "Microsoft",
  "Windows",
  "CurrentVersion",
  "Explorer",
  "StartupApproved",
  "Run",
].join("\\");

/** Parse `reg query` stdout into { name, type, data } rows. */
function parseRegQuery(output) {
  const rows = [];
  for (const rawLine of String(output || "").split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    // reg.exe separates the three columns with runs of four spaces.
    const match = line.match(/^ {4}(.+?) {4}(REG_[A-Z_]+) {4}(.*)$/);
    if (match) {
      rows.push({ name: match[1], type: match[2], data: match[3] });
    }
  }
  return rows;
}

/**
 * Pull the executable out of a Run value's data.
 * Quoted is the common case; unquoted paths containing spaces have to be cut at `.exe`,
 * which is the same guess Windows itself makes.
 */
function extractExecutable(data) {
  const value = String(data || "").trim();
  if (!value) return "";

  if (value.startsWith('"')) {
    const closing = value.indexOf('"', 1);
    return closing === -1 ? value.slice(1) : value.slice(1, closing);
  }

  const exeMatch = value.match(/^(.*?\.exe)(\s|$)/i);
  return exeMatch ? exeMatch[1] : value.split(" ")[0];
}

function normalizePath(value) {
  return String(value || "")
    .replace(/^"|"$/g, "")
    .replace(/\//g, "\\")
    .toLowerCase();
}

/**
 * Task Manager / Windows Settings record their switch in StartupApproved as a binary blob
 * whose first byte carries the state: even means enabled, odd means the user disabled it.
 * A missing value means no one has ever touched it, which Windows treats as enabled.
 */
function isApprovedBinary(hex) {
  const cleaned = String(hex || "")
    .trim()
    .replace(/^0x/i, "");
  if (cleaned.length < 2) return true;
  const firstByte = parseInt(cleaned.slice(0, 2), 16);
  return Number.isNaN(firstByte) ? true : (firstByte & 1) === 0;
}

function defaultRegReader(key) {
  return execFileSync("reg", ["query", key], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * What Windows will actually do with this executable at login.
 *
 * Returns null when the registry could not be read at all, so callers can fall back
 * instead of reporting a confident "off" they cannot back up.
 */
function readAutoStartRegistryState({ execPath, readKey = defaultRegReader } = {}) {
  const target = normalizePath(execPath);
  if (!target) return null;

  let runRows;
  try {
    runRows = parseRegQuery(readKey(RUN_KEY));
  } catch {
    // A missing Run key throws in reg.exe the same way a real failure does. Treating it as
    // "unreadable" is the safe reading: callers fall back rather than guess.
    return null;
  }

  const entry = runRows.find((row) => normalizePath(extractExecutable(row.data)) === target);
  if (!entry) {
    return { registered: false, approved: false, name: null };
  }

  let approved = true;
  try {
    const approvedRow = parseRegQuery(readKey(APPROVED_KEY)).find((row) => row.name === entry.name);
    if (approvedRow) {
      approved = isApprovedBinary(approvedRow.data);
    }
  } catch {
    // No StartupApproved key means nothing has been disabled — enabled stands.
  }

  return { registered: true, approved, name: entry.name };
}

/** True only when Windows will really launch it: registered AND not disabled by the user. */
function registryAutoStartEnabled(state) {
  return Boolean(state && state.registered && state.approved);
}

module.exports = {
  RUN_KEY,
  APPROVED_KEY,
  parseRegQuery,
  extractExecutable,
  isApprovedBinary,
  readAutoStartRegistryState,
  registryAutoStartEnabled,
};
